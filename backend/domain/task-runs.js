const { execFileSync } = require('child_process');
const {
  ATTEMPT_IDLE_GAP_MS,
  TASK_RUN_REPORT_VERSION
} = require('./taxonomy');

function normalizeModelName(model) {
  if (!model || typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  return trimmed.replace(/-\d{8}$/u, '');
}

function createTaskRunsDomain({
  db,
  parseJSONSafe,
  autoLabelTaskRunIfEligible
}) {
  const gitRevisionCache = new Map();

  function buildTaskRunsWhereClause(query = {}, taskRunsAlias = 'task_runs') {
    const {
      runner,
      status,
      source,
      from,
      to,
      query: textQuery,
      canonical_outcome_label,
      failure_mode,
      failure_subtype,
      requires_human_intervention,
      has_canonical_outcome
    } = query;

    const where = ['1=1'];
    const params = [];

    if (runner && runner !== 'all') {
      where.push(`${taskRunsAlias}.runner = ?`);
      params.push(runner);
    }
    if (status && status !== 'all') {
      where.push(`${taskRunsAlias}.status = ?`);
      params.push(status);
    }
    if (source && source !== 'all') {
      where.push(`${taskRunsAlias}.source = ?`);
      params.push(source);
    }
    if (from) {
      where.push(`${taskRunsAlias}.started_at >= ?`);
      params.push(from);
    }
    if (to) {
      where.push(`${taskRunsAlias}.started_at <= ?`);
      params.push(to);
    }
    if (textQuery) {
      where.push(`(${taskRunsAlias}.task_key LIKE ? OR ${taskRunsAlias}.title LIKE ? OR ${taskRunsAlias}.description LIKE ? OR ${taskRunsAlias}.root_session_id LIKE ?)`);
      const like = `%${textQuery}%`;
      params.push(like, like, like, like);
    }

    if (has_canonical_outcome === 'true') {
      where.push(`EXISTS (
        SELECT 1 FROM outcomes o
        WHERE o.task_run_id = ${taskRunsAlias}.id
          AND o.is_canonical = 1
      )`);
    } else if (has_canonical_outcome === 'false') {
      where.push(`NOT EXISTS (
        SELECT 1 FROM outcomes o
        WHERE o.task_run_id = ${taskRunsAlias}.id
          AND o.is_canonical = 1
      )`);
    }

    if (canonical_outcome_label && canonical_outcome_label !== 'all') {
      if (canonical_outcome_label === 'none') {
        where.push(`NOT EXISTS (
          SELECT 1 FROM outcomes o
          WHERE o.task_run_id = ${taskRunsAlias}.id
            AND o.is_canonical = 1
        )`);
      } else {
        where.push(`EXISTS (
          SELECT 1 FROM outcomes o
          WHERE o.task_run_id = ${taskRunsAlias}.id
            AND o.is_canonical = 1
            AND o.outcome_label = ?
        )`);
        params.push(canonical_outcome_label);
      }
    }

    if (failure_mode && failure_mode !== 'all') {
      where.push(`EXISTS (
        SELECT 1 FROM outcomes o
        WHERE o.task_run_id = ${taskRunsAlias}.id
          AND o.is_canonical = 1
          AND o.failure_mode = ?
      )`);
      params.push(failure_mode);
    }

    if (failure_subtype && failure_subtype !== 'all') {
      where.push(`EXISTS (
        SELECT 1 FROM outcomes o
        WHERE o.task_run_id = ${taskRunsAlias}.id
          AND o.is_canonical = 1
          AND o.failure_subtype = ?
      )`);
      params.push(failure_subtype);
    }

    if (requires_human_intervention === 'true') {
      where.push(`EXISTS (
        SELECT 1 FROM outcomes o
        WHERE o.task_run_id = ${taskRunsAlias}.id
          AND o.is_canonical = 1
          AND o.requires_human_intervention = 1
      )`);
    } else if (requires_human_intervention === 'false') {
      where.push(`EXISTS (
        SELECT 1 FROM outcomes o
        WHERE o.task_run_id = ${taskRunsAlias}.id
          AND o.is_canonical = 1
          AND o.requires_human_intervention = 0
      )`);
    }

    return {
      whereSql: where.join(' AND '),
      params
    };
  }

  function resolveGitRevision(directoryPath) {
    if (!directoryPath || typeof directoryPath !== 'string') return null;
    if (gitRevisionCache.has(directoryPath)) return gitRevisionCache.get(directoryPath);

    let revision = null;
    try {
      revision = execFileSync('git', ['-C', directoryPath, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() || null;
    } catch {
      revision = null;
    }

    gitRevisionCache.set(directoryPath, revision);
    return revision;
  }

  function deriveProvenance(parsedEvents, usageRows, sessionStart, firstEvent) {
    const modelCandidates = [
      ...usageRows.map(event => event?.data?.model).filter(Boolean),
      ...parsedEvents.map(event => event?.data?.model).filter(Boolean)
    ];
    const rawModel = modelCandidates.length ? modelCandidates[modelCandidates.length - 1] : null;
    const model = normalizeModelName(rawModel);

    const runnerVersionCandidates = [
      sessionStart?.data?.runnerVersion,
      sessionStart?.data?.version,
      sessionStart?.data?.cliVersion,
      sessionStart?.data?.claudeCodeVersion,
      sessionStart?.data?.opencodeVersion,
      ...parsedEvents.map(event =>
        event?.data?.runnerVersion ||
        event?.data?.version ||
        event?.data?.cliVersion ||
        event?.data?.claudeCodeVersion ||
        event?.data?.opencodeVersion ||
        null
      ).filter(Boolean)
    ].filter(Boolean);
    const runnerVersion = runnerVersionCandidates.length
      ? String(runnerVersionCandidates[runnerVersionCandidates.length - 1])
      : null;

    const directory = sessionStart?.data?.directory || firstEvent?.data?.directory || null;
    const gitRevision = resolveGitRevision(directory);

    return {
      model,
      rawModel: rawModel || null,
      runnerVersion,
      gitRevision
    };
  }

  function deriveTaskRunStatus(rows) {
    const endRows = rows.filter(row => row.event === 'session.end');
    if (endRows.length > 0) {
      const lastEnd = parseJSONSafe(endRows[endRows.length - 1].data, {});
      const reason = lastEnd?.data?.reason;
      if (reason === 'cancelled' || reason === 'user_cancelled') return 'cancelled';
      if (reason === 'timeout' || reason === 'timed_out') return 'timed_out';
      if (reason === 'error' || reason === 'failed' || reason === 'failure') return 'failed';
      return 'completed';
    }

    return 'running';
  }

  function summarizeTaskRunRows(rows) {
    const parsed = rows.map(row => parseJSONSafe(row.data, {}));
    const first = parsed[0] || {};
    const last = parsed[parsed.length - 1] || {};
    const toolEndRows = parsed.filter(event => event.event === 'tool.end');
    const distinctTools = new Set(parsed.map(event => event?.data?.tool).filter(Boolean));
    const usageRows = parsed.filter(event => event.event === 'usage');
    const subagentIds = new Set(parsed.map(event => event?.data?.agentId).filter(Boolean));

    let tokenInput = 0;
    let tokenOutput = 0;
    let tokenCacheCreation = 0;
    let tokenCacheRead = 0;
    let estimatedCost = 0;
    let estimatedCostKnown = false;
    let interruptCount = 0;

    for (const event of usageRows) {
      const data = event.data || {};
      tokenInput += data.inputTokens || 0;
      tokenOutput += data.outputTokens || 0;
      tokenCacheCreation += data.cacheCreationTokens || 0;
      tokenCacheRead += data.cacheReadTokens || 0;
      if (typeof data.cost === 'number' && Number.isFinite(data.cost)) {
        estimatedCostKnown = true;
        estimatedCost += data.cost;
      }
    }

    for (const event of parsed) {
      if (event?.data?.isInterrupt) interruptCount++;
    }

    const sessionStart = parsed.find(event => event.event === 'session.start');
    const title = sessionStart?.data?.title || first?.data?.title || null;
    const description = sessionStart?.data?.directory || null;
    const provenance = deriveProvenance(parsed, usageRows, sessionStart, first);

    return {
      title,
      description,
      runner: first.runner || null,
      model: provenance.model,
      agentSystemVersion: provenance.runnerVersion,
      toolchainVersion: provenance.runnerVersion,
      gitRevision: provenance.gitRevision,
      startedAt: first.ts || null,
      endedAt: last.ts || null,
      status: deriveTaskRunStatus(rows),
      totalEvents: rows.length,
      totalToolCalls: toolEndRows.length,
      distinctTools: distinctTools.size,
      totalDurationMs: toolEndRows.reduce((sum, event) => sum + (event.data?.durationMs || 0), 0),
      errorCount: parsed.filter(event =>
        event.event === 'error' || (event.event === 'tool.end' && event.data?.status === 'error')
      ).length,
      retryCount: Math.max(toolEndRows.length - distinctTools.size, 0),
      subagentCount: subagentIds.size,
      interruptCount,
      tokenInput,
      tokenOutput,
      tokenCacheCreation,
      tokenCacheRead,
      estimatedCostKnown: estimatedCostKnown ? 1 : 0,
      estimatedCost: +estimatedCost.toFixed(6),
      metadata: JSON.stringify({
        sessionIds: [...new Set(rows.map(row => row.sessionID).filter(Boolean))],
        tools: [...distinctTools],
        modelRaw: provenance.rawModel,
        runnerVersion: provenance.runnerVersion
      })
    };
  }

  function splitRowsIntoAttemptRuns(rows) {
    if (!rows.length) return [];

    const attempts = [];
    let current = [];
    let prevTsMs = null;
    let prevEvent = null;

    for (const row of rows) {
      const isSessionStart = row.event === 'session.start' && !!row.sessionID;
      const rowTsMs = row.ts ? Date.parse(row.ts) : NaN;
      const gapExceeded = Number.isFinite(prevTsMs) && Number.isFinite(rowTsMs)
        ? (rowTsMs - prevTsMs > ATTEMPT_IDLE_GAP_MS)
        : false;
      const startsAfterEnd = prevEvent === 'session.end';

      if (current.length > 0 && (isSessionStart || gapExceeded || startsAfterEnd)) {
        attempts.push(current);
        current = [];
      }

      current.push(row);
      prevTsMs = Number.isFinite(rowTsMs) ? rowTsMs : prevTsMs;
      prevEvent = row.event || null;
    }

    if (current.length > 0) attempts.push(current);
    return attempts;
  }

  function upsertTaskRunForRootSession(rootSessionId) {
    if (!rootSessionId) return [];

    const rows = db.prepare(`
      SELECT key, ts, sessionID, rootSessionID, runner, event, data
      FROM entries
      WHERE rootSessionID = ? OR sessionID = ?
      ORDER BY ts ASC, id ASC
    `).all(rootSessionId, rootSessionId);

    if (rows.length === 0) return [];
    const attempts = splitRowsIntoAttemptRuns(rows);

    const upsert = db.prepare(`
      INSERT INTO task_runs (
        task_key, title, description, source, runner, model, agent_system_version, toolchain_version, git_revision, status, root_session_id,
        started_at, ended_at, total_events, total_tool_calls, distinct_tools,
        total_duration_ms, error_count, retry_count, subagent_count, interrupt_count,
        token_input, token_output, token_cache_creation, token_cache_read,
        estimated_cost, estimated_cost_known, metadata, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_key) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        source = excluded.source,
        runner = excluded.runner,
        model = excluded.model,
        agent_system_version = excluded.agent_system_version,
        toolchain_version = excluded.toolchain_version,
        git_revision = excluded.git_revision,
        status = excluded.status,
        root_session_id = excluded.root_session_id,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        total_events = excluded.total_events,
        total_tool_calls = excluded.total_tool_calls,
        distinct_tools = excluded.distinct_tools,
        total_duration_ms = excluded.total_duration_ms,
        error_count = excluded.error_count,
        retry_count = excluded.retry_count,
        subagent_count = excluded.subagent_count,
        interrupt_count = excluded.interrupt_count,
        token_input = excluded.token_input,
        token_output = excluded.token_output,
        token_cache_creation = excluded.token_cache_creation,
        token_cache_read = excluded.token_cache_read,
        estimated_cost = excluded.estimated_cost,
        estimated_cost_known = excluded.estimated_cost_known,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `);

    const replaceLinks = db.transaction((taskRunId, eventRows) => {
      db.prepare('DELETE FROM task_run_events WHERE task_run_id = ?').run(taskRunId);
      const insertLink = db.prepare(`
        INSERT OR IGNORE INTO task_run_events (task_run_id, entry_key)
        VALUES (?, ?)
      `);
      for (const row of eventRows) {
        insertLink.run(taskRunId, row.key);
      }
    });

    const taskRunIds = [];
    attempts.forEach((attemptRows, idx) => {
      const summary = summarizeTaskRunRows(attemptRows);
      const taskKey = `root:${rootSessionId}::attempt:${idx + 1}`;

      upsert.run(
        taskKey,
        summary.title,
        summary.description,
        'derived_attempt',
        summary.runner,
        summary.model,
        summary.agentSystemVersion,
        summary.toolchainVersion,
        summary.gitRevision,
        summary.status,
        rootSessionId,
        summary.startedAt,
        summary.endedAt,
        summary.totalEvents,
        summary.totalToolCalls,
        summary.distinctTools,
        summary.totalDurationMs,
        summary.errorCount,
        summary.retryCount,
        summary.subagentCount,
        summary.interruptCount,
        summary.tokenInput,
        summary.tokenOutput,
        summary.tokenCacheCreation,
        summary.tokenCacheRead,
        summary.estimatedCost,
        summary.estimatedCostKnown,
        summary.metadata,
        new Date().toISOString()
      );

      const taskRun = db.prepare('SELECT id FROM task_runs WHERE task_key = ?').get(taskKey);
      if (!taskRun?.id) return;
      replaceLinks(taskRun.id, attemptRows);
      autoLabelTaskRunIfEligible(taskRun.id, summary);
      taskRunIds.push(taskRun.id);
    });

    return taskRunIds;
  }

  function getTaskRunById(taskRunId) {
    return db.prepare(`
      SELECT *
      FROM task_runs
      WHERE id = ?
    `).get(taskRunId);
  }

  function formatTaskRunAfterActionReportMarkdown(report) {
    const summary = report.summary || {};
    const outcome = report.canonical_outcome;
    const sections = report.sections || {};
    const evidence = report.evidence || {};

    const lines = [
      '# After-Action Report',
      '',
      `- Task run: \`${report.task_run_id}\``,
      `- Status: ${report.status}`,
      `- Generated at: ${report.generated_at}`,
      '',
      '## Summary',
      '',
      `- Title: ${summary.title || '—'}`,
      `- Task key: \`${summary.task_key || '—'}\``,
      `- Attempt: ${summary.attempt_number ?? '—'}`,
      `- Runner: ${summary.runner || '—'}`,
      `- Model: ${summary.model || '—'}`,
      `- Runner version: ${summary.runner_version || '—'}`,
      `- Started: ${summary.started_at || '—'}`,
      `- Ended: ${summary.ended_at || '—'}`,
      `- Duration: ${summary.total_duration_ms ?? 0} ms`,
      `- Tool calls: ${summary.total_tool_calls ?? 0}`,
      `- Errors: ${summary.error_count ?? 0}`,
      `- Interrupts: ${summary.interrupt_count ?? 0}`,
      ''
    ];

    lines.push('## Canonical Outcome', '');
    if (!outcome) {
      lines.push('- Missing canonical outcome.');
    } else {
      lines.push(`- Label: ${outcome.outcome_label}`);
      lines.push(`- Evaluation type: ${outcome.evaluation_type}`);
      lines.push(`- Evaluator: ${outcome.evaluator || '—'}`);
      lines.push(`- Failure mode: ${outcome.failure_mode || '—'}`);
      lines.push(`- Failure subtype: ${outcome.failure_subtype || '—'}`);
      lines.push(`- Human intervention: ${outcome.requires_human_intervention ? 'yes' : 'no'}`);
      if (outcome.notes) lines.push(`- Notes: ${outcome.notes}`);
    }
    lines.push('');

    const sectionSpecs = [
      ['What Happened', sections.what_happened || []],
      ['Variance Vs Expected', sections.variance_vs_expected || []],
      ['Top Risks', sections.risks || []],
      ['Remediation', sections.remediation || []]
    ];
    for (const [heading, items] of sectionSpecs) {
      lines.push(`## ${heading}`, '');
      if (!items.length) lines.push('- None.');
      else items.forEach((item) => lines.push(`- ${item}`));
      lines.push('');
    }

    lines.push('## Evidence', '');
    const topTools = evidence.top_tools || [];
    if (topTools.length) {
      lines.push('- Top tools:');
      topTools.forEach((tool) => lines.push(`  - ${tool.tool}: ${tool.count}`));
    } else {
      lines.push('- Top tools: none');
    }
    const keyEvents = evidence.key_events || [];
    if (keyEvents.length) {
      lines.push('- Key events:');
      keyEvents.forEach((event) => {
        const extra = [event.tool, event.status, event.agentType, event.reason].filter(Boolean).join(' | ');
        lines.push(`  - ${event.ts} ${event.event}${extra ? ` (${extra})` : ''}`);
      });
    } else {
      lines.push('- Key events: none');
    }

    return lines.join('\n').trim();
  }

  function buildTaskRunAfterActionReport(taskRunId) {
    const taskRun = getTaskRunById(taskRunId);
    if (!taskRun) return null;

    const canonicalOutcome = db.prepare(`
      SELECT *
      FROM outcomes
      WHERE task_run_id = ?
        AND is_canonical = 1
      ORDER BY evaluated_at DESC, id DESC
      LIMIT 1
    `).get(taskRunId);

    const eventRows = db.prepare(`
      SELECT e.key, e.ts, e.event, e.data
      FROM task_run_events tre
      JOIN entries e ON e.key = tre.entry_key
      WHERE tre.task_run_id = ?
      ORDER BY e.ts ASC, e.id ASC
    `).all(taskRunId);

    const events = eventRows.map((row) => ({
      key: row.key,
      ts: row.ts,
      event: row.event,
      data: parseJSONSafe(row.data, {})
    }));
    const metadata = parseJSONSafe(taskRun.metadata, null) || {};
    const attemptMatch = String(taskRun.task_key || '').match(/::attempt:(\d+)$/);
    const attemptNumber = attemptMatch ? Number.parseInt(attemptMatch[1], 10) : null;

    const eventCounts = {};
    const toolCounts = new Map();
    for (const event of events) {
      eventCounts[event.event] = (eventCounts[event.event] || 0) + 1;
      if (event.event === 'tool.end') {
        const toolName = event?.data?.tool || 'unknown';
        toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
      }
    }

    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([tool, count]) => ({ tool, count }));

    const keyEvents = [];
    const eventSelectors = [
      (e) => e.event === 'session.start',
      (e) => e.event === 'tool.start',
      (e) => e.event === 'tool.end' && e?.data?.status === 'error',
      (e) => e.event === 'error',
      (e) => e.event === 'session.end'
    ];
    for (const selector of eventSelectors) {
      const match = events.find(selector);
      if (!match) continue;
      keyEvents.push({
        ts: match.ts,
        event: match.event,
        tool: match?.data?.tool || null,
        status: match?.data?.status || null,
        agentType: match?.data?.agentType || null,
        reason: match?.data?.reason || null
      });
    }

    const sections = {
      what_happened: [
        `Run processed ${taskRun.total_events || 0} events and ${taskRun.total_tool_calls || 0} tool calls.`,
        `Distinct tools used: ${taskRun.distinct_tools || 0}.`,
        `Retries observed: ${taskRun.retry_count || 0}.`
      ],
      variance_vs_expected: [],
      risks: [],
      remediation: []
    };

    if (!canonicalOutcome) {
      sections.what_happened.push('Canonical outcome is missing, so reliability judgment is incomplete.');
      sections.variance_vs_expected.push('Expected vs actual cannot be resolved without canonical outcome labeling.');
      sections.remediation.push('Record a canonical outcome label for this run before using this report for KPI decisions.');

      const insufficientReport = {
        task_run_id: taskRun.id,
        status: 'insufficient_evidence',
        generated_at: new Date().toISOString(),
        summary: {
          task_key: taskRun.task_key,
          title: taskRun.title || null,
          attempt_number: attemptNumber,
          runner: taskRun.runner || null,
          model: taskRun.model || null,
          runner_version: taskRun.agent_system_version || taskRun.toolchain_version || metadata.runnerVersion || null,
          started_at: taskRun.started_at || null,
          ended_at: taskRun.ended_at || null,
          total_duration_ms: taskRun.total_duration_ms || 0,
          total_tool_calls: taskRun.total_tool_calls || 0,
          error_count: taskRun.error_count || 0,
          interrupt_count: taskRun.interrupt_count || 0
        },
        canonical_outcome: null,
        sections,
        evidence: {
          event_counts: eventCounts,
          top_tools: topTools,
          key_events: keyEvents
        }
      };
      insufficientReport.markdown = formatTaskRunAfterActionReportMarkdown(insufficientReport);
      return insufficientReport;
    }

    const normalizedOutcome = {
      id: canonicalOutcome.id,
      outcome_label: canonicalOutcome.outcome_label,
      evaluation_type: canonicalOutcome.evaluation_type,
      failure_mode: canonicalOutcome.failure_mode || null,
      failure_subtype: canonicalOutcome.failure_subtype || null,
      requires_human_intervention: !!canonicalOutcome.requires_human_intervention,
      evaluator: canonicalOutcome.evaluator || null,
      notes: canonicalOutcome.notes || null,
      evaluated_at: canonicalOutcome.evaluated_at
    };

    if (normalizedOutcome.outcome_label === 'success') {
      sections.variance_vs_expected.push('Outcome is labeled success; execution matched expected completion criteria.');
    } else if (normalizedOutcome.outcome_label === 'partial_success') {
      sections.variance_vs_expected.push('Outcome is partial_success; expected completion was only partially met.');
    } else if (normalizedOutcome.outcome_label === 'failure') {
      sections.variance_vs_expected.push('Outcome is failure; expected completion was not achieved.');
    } else {
      sections.variance_vs_expected.push(`Outcome is ${normalizedOutcome.outcome_label}; completion state requires contextual interpretation.`);
    }
    if (normalizedOutcome.failure_mode) {
      sections.variance_vs_expected.push(`Primary failure mode: ${normalizedOutcome.failure_mode}.`);
    }
    if (normalizedOutcome.failure_subtype) {
      sections.variance_vs_expected.push(`Failure subtype: ${normalizedOutcome.failure_subtype}.`);
    }

    if (taskRun.error_count > 0) sections.risks.push(`Observed ${taskRun.error_count} error events.`);
    if (taskRun.interrupt_count > 0) sections.risks.push(`Observed ${taskRun.interrupt_count} interrupt signals.`);
    if ((taskRun.retry_count || 0) > 0) sections.risks.push(`Retry pressure present (${taskRun.retry_count} retries).`);
    if (normalizedOutcome.failure_mode) sections.risks.push(`Canonical failure mode is ${normalizedOutcome.failure_mode}.`);
    if (normalizedOutcome.requires_human_intervention) sections.risks.push('Human intervention was required.');

    const remediationByFailureMode = {
      planning_failure: 'Tighten plan decomposition and add explicit acceptance checks before execution.',
      execution_failure: 'Add stronger tool-result validation and stop-on-error guardrails before continuing.',
      validation_failure: 'Require explicit verification steps and expected-output assertions before declaring completion.',
      safety_failure: 'Add preflight safety checks and stricter gating for potentially unsafe operations.',
      environment_failure: 'Capture environment/runtime prerequisites and fail fast on missing dependencies.',
      integration_failure: 'Stabilize API contracts and add compatibility checks for runner/integration versions.'
    };

    if (normalizedOutcome.failure_mode && remediationByFailureMode[normalizedOutcome.failure_mode]) {
      sections.remediation.push(remediationByFailureMode[normalizedOutcome.failure_mode]);
    }
    if ((taskRun.retry_count || 0) > 0) {
      sections.remediation.push('Reduce retries by adding explicit intermediate checkpoints and tighter success criteria per step.');
    }
    if (taskRun.error_count > 0) {
      sections.remediation.push('Capture failing tool invocations as reusable regression scenarios in benchmarks.');
    }
    if (!sections.remediation.length) {
      sections.remediation.push('No immediate remediation required; continue monitoring for trend regressions.');
    }

    const report = {
      task_run_id: taskRun.id,
      status: 'ready',
      generated_at: new Date().toISOString(),
      summary: {
        task_key: taskRun.task_key,
        title: taskRun.title || null,
        attempt_number: attemptNumber,
        runner: taskRun.runner || null,
        model: taskRun.model || null,
        runner_version: taskRun.agent_system_version || taskRun.toolchain_version || metadata.runnerVersion || null,
        started_at: taskRun.started_at || null,
        ended_at: taskRun.ended_at || null,
        total_duration_ms: taskRun.total_duration_ms || 0,
        total_tool_calls: taskRun.total_tool_calls || 0,
        error_count: taskRun.error_count || 0,
        interrupt_count: taskRun.interrupt_count || 0
      },
      canonical_outcome: normalizedOutcome,
      sections,
      evidence: {
        event_counts: eventCounts,
        top_tools: topTools,
        key_events: keyEvents
      }
    };
    report.markdown = formatTaskRunAfterActionReportMarkdown(report);
    return report;
  }

  function getStoredTaskRunAfterActionReport(taskRunId) {
    const row = db.prepare(`
      SELECT report_json, generated_at, report_version, based_on_outcome_id, based_on_task_run_updated_at
      FROM task_run_reports
      WHERE task_run_id = ?
    `).get(taskRunId);
    if (!row) return null;
    const parsed = parseJSONSafe(row.report_json, null);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      report: parsed,
      generated_at: row.generated_at || null,
      report_version: row.report_version || null,
      based_on_outcome_id: row.based_on_outcome_id || null,
      based_on_task_run_updated_at: row.based_on_task_run_updated_at || null
    };
  }

  function upsertStoredTaskRunAfterActionReport(taskRunId, report, reportContext) {
    const generatedAt = report?.generated_at || new Date().toISOString();
    db.prepare(`
      INSERT INTO task_run_reports (
        task_run_id, report_json, generated_at, report_version, based_on_outcome_id, based_on_task_run_updated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_run_id) DO UPDATE SET
        report_json = excluded.report_json,
        generated_at = excluded.generated_at,
        report_version = excluded.report_version,
        based_on_outcome_id = excluded.based_on_outcome_id,
        based_on_task_run_updated_at = excluded.based_on_task_run_updated_at,
        updated_at = excluded.updated_at
    `).run(
      taskRunId,
      JSON.stringify(report),
      generatedAt,
      TASK_RUN_REPORT_VERSION,
      reportContext?.canonicalOutcomeId || null,
      reportContext?.taskRunUpdatedAt || null,
      new Date().toISOString()
    );
  }

  function isStoredTaskRunReportFresh(storedReport, reportContext) {
    if (!storedReport || !reportContext) return false;
    if (storedReport.report_version !== TASK_RUN_REPORT_VERSION) return false;
    if ((storedReport.based_on_outcome_id || null) !== (reportContext.canonicalOutcomeId || null)) return false;
    if ((storedReport.based_on_task_run_updated_at || null) !== (reportContext.taskRunUpdatedAt || null)) return false;
    return true;
  }

  function backfillAllTaskRuns() {
    const rows = db.prepare(`
      SELECT DISTINCT COALESCE(rootSessionID, sessionID) AS rootSessionId
      FROM entries
      WHERE COALESCE(rootSessionID, sessionID) IS NOT NULL
      ORDER BY rootSessionId
    `).all();

    let derivedTaskRuns = 0;
    for (const row of rows) {
      if (!row.rootSessionId) continue;
      const taskRunIds = upsertTaskRunForRootSession(row.rootSessionId);
      derivedTaskRuns += taskRunIds.length;
    }

    return {
      rootSessions: rows.length,
      taskRuns: derivedTaskRuns
    };
  }

  return {
    buildTaskRunsWhereClause,
    summarizeTaskRunRows,
    splitRowsIntoAttemptRuns,
    upsertTaskRunForRootSession,
    getTaskRunById,
    formatTaskRunAfterActionReportMarkdown,
    buildTaskRunAfterActionReport,
    getStoredTaskRunAfterActionReport,
    upsertStoredTaskRunAfterActionReport,
    isStoredTaskRunReportFresh,
    backfillAllTaskRuns
  };
}

module.exports = {
  createTaskRunsDomain
};
