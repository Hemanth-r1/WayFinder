/**
 * Goraguntepalya at 100%: every approach of the two Goraguntepalya signals (Gorguntepalaya
 * Cross and Outer Ring Road × Tumkur Road) filled bumper-to-bumper for 600 m, heavy
 * arrivals continuing at 80% of capacity, measured for 40 simulated minutes.
 *
 *   npx tsx scripts/scenarioGoraguntepalya.ts <today|signals|signals+navigation> [out.json]
 *
 * Same random seed for every mode, so each starts from the same city and the same jam.
 */
import { writeFile } from 'node:fs/promises';
import { getGraph } from '../src/graphService.js';
import { getGraphIndex } from '../src/pathfindingService.js';
import { initJunctions } from '../src/junctionService.js';
import { initSimulationEngine } from '../src/simulationEngine.js';
import { recordMovement } from '../src/countsService.js';
import { runSurge, type ScenarioMode } from '../src/scenarioService.js';
import { seededRandom } from '../src/osmGraph.js';

const mode = (process.argv[2] ?? 'today') as ScenarioMode;
const out = process.argv[3];
Math.random = seededRandom(42);

const JUNCTIONS = ['J5HVHATD', 'J5JG4TUG'];
const CENTRE = { lat: 13.0297, lng: 77.5388 };

const { graph, signals, places } = await getGraph();
initJunctions(getGraphIndex(graph, signals), signals, places);
const engine = initSimulationEngine(graph, signals);
engine.setMovementHandler(recordMovement);
// Background traffic: a busy evening within ~6 km of Goraguntepalya
engine.setSpawnArea([CENTRE.lng - 0.055, CENTRE.lat - 0.055, CENTRE.lng + 0.055, CENTRE.lat + 0.055], 2500);
for (let i = 0; i < 4 * 60 * 4; i++) await engine.update(0.25); // 4 min warm-up

const t0 = Date.now();
const result = await runSurge(mode, { junctionIds: JUNCTIONS, fillMetres: 600, arrivalShare: 0.8, appShare: 0.4 }, 40, 0.25);
console.log(JSON.stringify({ ...result, timeline: undefined, runSeconds: Math.round((Date.now() - t0) / 1000) }));
if (out) await writeFile(out, JSON.stringify(result, null, 2));
process.exit(0);
