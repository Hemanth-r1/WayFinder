/**
 * Refreshes the bundled Bangalore road snapshot (server/data/bangalore-osm.json.gz).
 *
 *   npm run build:osm                  # download from Overpass
 *   npm run build:osm -- --from <dir>  # use Overpass JSON files already downloaded (*.json)
 *
 * Re-run occasionally to pick up OpenStreetMap edits; commit the result.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compactFromOverpass, fetchBangaloreFromOverpass, writeSnapshot, SNAPSHOT_PATH } from '../src/osmSource.js';
import { buildGraphFromOsm } from '../src/osmGraph.js';
import type { CompactOsm } from '../src/osmGraph.js';

async function main() {
  const fromIdx = process.argv.indexOf('--from');
  let osm: CompactOsm;
  if (fromIdx > 0) {
    const dir = process.argv[fromIdx + 1];
    const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
    const elements = [];
    for (const f of files) {
      const data = JSON.parse(await readFile(join(dir, f), 'utf8'));
      if (Array.isArray(data.elements)) elements.push(...data.elements);
    }
    osm = compactFromOverpass(elements, `OpenStreetMap via Overpass (${new Date().toISOString().slice(0, 10)})`);
  } else {
    osm = await fetchBangaloreFromOverpass(300_000);
    osm.source = `OpenStreetMap via Overpass (${new Date().toISOString().slice(0, 10)})`;
  }

  const { graph, signals } = buildGraphFromOsm(osm);
  const bytes = await writeSnapshot(osm);
  console.log(`OSM: ${osm.ways.length} ways, ${osm.nodes.length} nodes, ${osm.signals.length} signal nodes`);
  console.log(`Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${signals.length} signal controllers`);
  console.log(`Wrote ${SNAPSHOT_PATH} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
