import { readFile } from 'node:fs/promises';
import { smartAutoAssign } from '../src/smart-seating.js';
const data = JSON.parse(await readFile('/var/lib/seating-studio/workspaces.json','utf8'));
for (const workspace of data.workspaces) {
  const balanced = smartAutoAssign(workspace.guests, workspace.tables, workspace.details, { style: 'balanced', tableUsage: 'efficient', priorityMemberships: ['Premium Corporate Member'], balanceLeaders: true });
  const networking = smartAutoAssign(workspace.guests, workspace.tables, workspace.details, { style: 'networking', tableUsage: 'efficient', priorityMemberships: ['Premium Corporate Member'], balanceLeaders: true });
  const company = smartAutoAssign(workspace.guests, workspace.tables, workspace.details, { style: 'company', tableUsage: 'efficient', priorityMemberships: ['Premium Corporate Member'], balanceLeaders: true });
  const summarize = result => result.summary;
  console.log(JSON.stringify({ event: workspace.id, guests: workspace.guests.length, tables: workspace.tables.length, zones: [...new Set(workspace.tables.map(t => t.zone))], priorityZone: workspace.details.vipZone, balanced: summarize(balanced), networking: summarize(networking), company: summarize(company) }));
}
