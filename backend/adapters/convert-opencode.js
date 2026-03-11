#!/usr/bin/env node
/**
 * Convert OpenCode JSONL to CEP format
 *
 * Usage:
 *   node adapters/convert-opencode.js input.jsonl output.jsonl
 *   node adapters/convert-opencode.js input.jsonl output.jsonl --preview 10
 */

const fs = require('fs');
const OpenCodeAdapter = require('./opencode.js');

// Parse arguments
const args = process.argv.slice(2);
const inputFile = args[0];
const outputFile = args[1];
const previewFlag = args.indexOf('--preview');
const previewCount = previewFlag !== -1 ? parseInt(args[previewFlag + 1]) || 10 : 0;

if (!inputFile || !outputFile) {
  console.error('Usage: node convert-opencode.js <input.jsonl> <output.jsonl> [--preview N]');
  process.exit(1);
}

console.log('Converting OpenCode JSONL to CEP format...');
console.log('Input:', inputFile);
console.log('Output:', outputFile);

const adapter = new OpenCodeAdapter();
const inputContent = fs.readFileSync(inputFile, 'utf-8');
const lines = inputContent.split(/\r?\n/).filter(line => line.trim());

console.log(`\nProcessing ${lines.length} lines...`);

let converted = 0;
let skipped = 0;
let errors = 0;

const outputStream = fs.createWriteStream(outputFile);

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  try {
    const event = JSON.parse(line);
    const cepEvent = adapter.translate(event);

    if (cepEvent) {
      outputStream.write(JSON.stringify(cepEvent) + '\n');
      converted++;

      // Preview mode
      if (previewCount > 0 && converted <= previewCount) {
        console.log('\n--- Original ---');
        console.log(JSON.stringify(event, null, 2));
        console.log('\n--- CEP ---');
        console.log(JSON.stringify(cepEvent, null, 2));
      }
    } else {
      skipped++;
    }
  } catch (err) {
    errors++;
    console.error(`Error on line ${i + 1}:`, err.message);
  }
}

outputStream.end();

console.log('\n=== Conversion Complete ===');
console.log(`Converted: ${converted} events`);
console.log(`Skipped: ${skipped} events (noise)`);
console.log(`Errors: ${errors} events`);
console.log(`Output file: ${outputFile}`);
