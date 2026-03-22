const API_BASE = `${window.location.origin}/api`;

export async function getEntries(filters) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) {
      params.append(key, value);
    }
  }

  const response = await fetch(`${API_BASE}/entries?${params}`);

  if (!response.ok) {
    throw new Error('Failed to fetch entries');
  }

  return response.json();
}

export async function getFacets() {
  const response = await fetch(`${API_BASE}/facets`);

  if (!response.ok) {
    throw new Error('Failed to fetch facets');
  }

  return response.json();
}

export async function getStats() {
  const response = await fetch(`${API_BASE}/stats`);

  if (!response.ok) {
    throw new Error('Failed to fetch stats');
  }

  return response.json();
}

export async function getTags() {
  const response = await fetch(`${API_BASE}/tags`);

  if (!response.ok) {
    throw new Error('Failed to fetch tags');
  }

  return response.json();
}

export async function addTag(entryKey, tag) {
  const response = await fetch(`${API_BASE}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryKey, tag, action: 'add' }),
  });

  if (!response.ok) {
    throw new Error('Failed to add tag');
  }

  return response.json();
}

export async function removeTag(entryKey, tag) {
  const response = await fetch(`${API_BASE}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryKey, tag, action: 'remove' }),
  });

  if (!response.ok) {
    throw new Error('Failed to remove tag');
  }

  return response.json();
}

export async function getNotes() {
  const response = await fetch(`${API_BASE}/notes`);

  if (!response.ok) {
    throw new Error('Failed to fetch notes');
  }

  return response.json();
}

export async function setNote(entryKey, note) {
  const response = await fetch(`${API_BASE}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryKey, note }),
  });

  if (!response.ok) {
    throw new Error('Failed to set note');
  }

  return response.json();
}

export async function exportTags() {
  const response = await fetch(`${API_BASE}/export`);

  if (!response.ok) {
    throw new Error('Failed to export');
  }

  return response.json();
}

export async function importTags(data) {
  const response = await fetch(`${API_BASE}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error('Failed to import');
  }

  return response.json();
}

/**
 * Subscribe to real-time event stream via SSE
 * @param {Function} onMessage - Called when new event arrives
 * @param {Function} onConnectionChange - Called when connection state changes (connected: boolean)
 * @returns {Function} - Unsubscribe function
 */
export function subscribeToEvents(onMessage, onConnectionChange) {
  const eventSource = new EventSource(`${API_BASE}/events/stream`);

  eventSource.onopen = () => {
    console.log('SSE connection opened');
    if (onConnectionChange) onConnectionChange(true);
  };

  eventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      onMessage(event);
    } catch (err) {
      console.error('Failed to parse SSE event:', err);
    }
  };

  eventSource.onerror = (err) => {
    console.error('SSE connection error:', err);
    if (onConnectionChange) onConnectionChange(false);
    // Browser will automatically reconnect
  };

  // Return unsubscribe function
  return () => {
    eventSource.close();
    if (onConnectionChange) onConnectionChange(false);
  };
}

/**
 * Analyze selected events with LLM (Anthropic API)
 * @param {Array<string>} keys - Event keys to analyze
 * @param {Object} options - Analysis options (model, apiKey, prompt)
 * @returns {Promise<Object>} - Analysis result
 */
export async function analyzeEvents(keys, options = {}) {
  const response = await fetch(`${API_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keys,
      model: options.model,
      apiKey: options.apiKey,
      prompt: options.prompt
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Analysis failed');
  }

  return response.json();
}

/**
 * Save selected event keys to selection.json for MCP bridge (CLI analysis)
 * @param {Array<string>} keys - Event keys to save
 * @returns {Promise<Object>} - { success: true, count: N }
 */
export async function saveSelection(keys) {
  const response = await fetch(`${API_BASE}/selection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to save selection');
  }

  return response.json();
}

/**
 * Get current selection saved for CLI
 * @returns {Promise<Object>} - Selection data
 */
export async function getSelection() {
  const response = await fetch(`${API_BASE}/selection`);

  if (!response.ok) {
    throw new Error('Failed to fetch selection');
  }

  return response.json();
}

/**
 * Get all saved analyses
 * @returns {Promise<Array>} - List of analysis summaries
 */
export async function getAnalyses() {
  const response = await fetch(`${API_BASE}/analyses-history`);

  if (!response.ok) {
    throw new Error('Failed to fetch analyses');
  }

  return response.json();
}

/**
 * Get a specific analysis by ID
 * @param {number} id - Analysis ID
 * @returns {Promise<Object>} - Full analysis details
 */
export async function getAnalysis(id) {
  const response = await fetch(`${API_BASE}/analyses-history/${id}`);

  if (!response.ok) {
    throw new Error('Failed to fetch analysis');
  }

  return response.json();
}

/**
 * Delete an analysis
 * @param {number} id - Analysis ID
 * @returns {Promise<Object>} - Success response
 */
export async function deleteAnalysis(id) {
  const response = await fetch(`${API_BASE}/analyses-history/${id}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    throw new Error('Failed to delete analysis');
  }

  return response.json();
}

export async function deriveTaskRuns() {
  const response = await fetch(`${API_BASE}/task-runs/derive`, {
    method: 'POST'
  });

  if (!response.ok) {
    throw new Error('Failed to derive task runs');
  }

  return response.json();
}

export async function getTaskRuns(filters = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) {
      params.append(key, value);
    }
  }

  const response = await fetch(`${API_BASE}/task-runs?${params}`);

  if (!response.ok) {
    throw new Error('Failed to fetch task runs');
  }

  return response.json();
}

export async function getTaskRun(id) {
  const response = await fetch(`${API_BASE}/task-runs/${id}`);

  if (!response.ok) {
    throw new Error('Failed to fetch task run');
  }

  return response.json();
}

export async function getTaskRunOutcomeSummary(filters = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) {
      params.append(key, value);
    }
  }

  const response = await fetch(`${API_BASE}/task-runs/outcome-summary?${params}`);

  if (!response.ok) {
    throw new Error('Failed to fetch task run outcome summary');
  }

  return response.json();
}

export async function getReliabilityKpis(filters = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) {
      params.append(key, value);
    }
  }

  const response = await fetch(`${API_BASE}/reliability/kpis?${params}`);

  if (!response.ok) {
    throw new Error('Failed to fetch reliability KPIs');
  }

  return response.json();
}

export async function getKpiDefinitions() {
  const response = await fetch(`${API_BASE}/reliability/kpi-definitions`);

  if (!response.ok) {
    throw new Error('Failed to fetch KPI definitions');
  }

  return response.json();
}

export async function getReliabilityKpisByRunner(filters = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) {
      params.append(key, value);
    }
  }

  const response = await fetch(`${API_BASE}/reliability/kpis/by-runner?${params}`);

  if (!response.ok) {
    throw new Error('Failed to fetch reliability KPIs by runner');
  }

  return response.json();
}

export async function getReliabilityTrends(filters = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.append(key, value);
    }
  }

  const response = await fetch(`${API_BASE}/reliability/trends?${params}`);

  if (!response.ok) {
    throw new Error('Failed to fetch reliability trends');
  }

  return response.json();
}

export async function getReliabilityTrendInsights(filters = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.append(key, value);
    }
  }

  const response = await fetch(`${API_BASE}/reliability/trends/insights?${params}`);

  if (!response.ok) {
    throw new Error('Failed to fetch reliability trend insights');
  }

  return response.json();
}

export async function createOutcome(taskRunId, outcome) {
  const response = await fetch(`${API_BASE}/task-runs/${taskRunId}/outcomes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(outcome)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create outcome');
  }

  return response.json();
}

export async function createOutcomesBatch(items) {
  const response = await fetch(`${API_BASE}/task-runs/outcomes/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create outcomes batch');
  }

  return response.json();
}

export async function getOutcomeTaxonomy() {
  const response = await fetch(`${API_BASE}/meta/outcome-taxonomy`);

  if (!response.ok) {
    throw new Error('Failed to fetch outcome taxonomy');
  }

  return response.json();
}

export async function getBenchmarks() {
  const response = await fetch(`${API_BASE}/benchmarks`);

  if (!response.ok) {
    throw new Error('Failed to fetch benchmarks');
  }

  return response.json();
}
