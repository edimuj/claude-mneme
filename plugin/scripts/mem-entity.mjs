#!/usr/bin/env node
/**
 * Entity Query Script
 * Queries the entity index to find information about files, functions, errors, packages.
 *
 * Usage:
 *   node mem-entity.mjs [options] [query]
 *
 * Options:
 *   --list              List all entities
 *   --category <cat>    Filter by category (files, functions, errors, packages)
 *   <query>             Search for entities matching this name
 */

import { loadEntityIndex, ensureMemoryDirs, getProjectName } from './utils.mjs';

const args = process.argv.slice(2);
const cwd = process.cwd();
const projectName = getProjectName(cwd);

// Parse arguments
let listMode = false;
let category = null;
let query = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--list') {
    listMode = true;
  } else if (arg === '--category' && args[i + 1]) {
    category = args[++i];
  } else if (!arg.startsWith('--')) {
    query = arg;
  }
}

// Load entity index
const index = loadEntityIndex(cwd);

// Check if index has any data
const hasData = index.files && (
  Object.keys(index.files).length > 0 ||
  Object.keys(index.functions || {}).length > 0 ||
  Object.keys(index.errors || {}).length > 0 ||
  Object.keys(index.packages || {}).length > 0
);

if (!hasData) {
  console.log(JSON.stringify({
    project: projectName,
    status: 'empty',
    message: 'No entities indexed yet. Entities are extracted from log entries as you work.'
  }));
  process.exit(0);
}

// List mode - show all entities
if (listMode) {
  const result = {
    project: projectName,
    status: 'ok',
    categories: {}
  };

  const categories = category ? [category] : ['files', 'functions', 'errors', 'packages'];

  for (const cat of categories) {
    if (!index[cat]) continue;

    const entities = Object.entries(index[cat])
      .map(([name, data]) => ({
        name,
        mentions: data.mentions,
        lastSeen: data.lastSeen
      }))
      .sort((a, b) => b.mentions - a.mentions);

    if (entities.length > 0) {
      result.categories[cat] = entities;
    }
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// Query mode - search for matching entities
if (query) {
  const queryLower = query.toLowerCase();
  const matches = [];

  const categories = category ? [category] : ['files', 'functions', 'errors', 'packages'];

  for (const cat of categories) {
    if (!index[cat]) continue;

    for (const [name, data] of Object.entries(index[cat])) {
      // Match if name contains query (case-insensitive)
      if (name.toLowerCase().includes(queryLower)) {
        matches.push({
          name,
          category: cat,
          mentions: data.mentions,
          lastSeen: data.lastSeen,
          contexts: data.contexts || []
        });
      }
    }
  }

  // Sort by relevance: exact match first, then by mentions
  matches.sort((a, b) => {
    const aExact = a.name.toLowerCase() === queryLower ? 1 : 0;
    const bExact = b.name.toLowerCase() === queryLower ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return b.mentions - a.mentions;
  });

  console.log(JSON.stringify({
    project: projectName,
    query,
    status: matches.length > 0 ? 'ok' : 'not_found',
    matches: matches.slice(0, 20) // Limit to top 20
  }, null, 2));
  process.exit(0);
}

// No query and not list mode - show summary
const summary = {
  project: projectName,
  status: 'ok',
  lastUpdated: index.lastUpdated,
  counts: {
    files: Object.keys(index.files || {}).length,
    functions: Object.keys(index.functions || {}).length,
    errors: Object.keys(index.errors || {}).length,
    packages: Object.keys(index.packages || {}).length
  },
  hint: 'Use --list to see all entities, or provide a query to search.'
};

console.log(JSON.stringify(summary, null, 2));
process.exit(0);
