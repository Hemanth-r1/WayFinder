import type { RoadGraph, TrafficSignal, RouteInfo } from './types.js';

export function findRoute(
  graph: RoadGraph, sourceId: string, destId: string, _signals: TrafficSignal[]
): RouteInfo | null {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const adj = new Map<string, string[]>(graph.adjacency);
  const edgeMap = new Map(graph.edges.map(e => [e.id, e]));

  const open = [{ id: sourceId, cost: 0, heuristic: 0 }];
  const closed = new Set<string>();
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  gScore.set(sourceId, 0);

  while (open.length > 0) {
    open.sort((a, b) => (a.cost + a.heuristic) - (b.cost + b.heuristic));
    const current = open.shift()!;
    if (current.id === destId) {
      const path: string[] = [];
      let c: string | undefined = destId;
      while (c) { path.unshift(c); c = cameFrom.get(c); }
      const roadNames = [...new Set(path.flatMap(id =>
        (adj.get(id) || []).map(eid => edgeMap.get(eid)?.name).filter(Boolean) as string[]
      ))];
      return {
        path,
        distance: path.length * 500,
        estimatedTime: path.length * 30,
        signalCount: path.filter(id => _signals.some(s => s.nodeId === id)).length,
        roadNames,
      };
    }
    closed.add(current.id);
    const neighbors = adj.get(current.id) || [];
    for (const edgeId of neighbors) {
      const edge = edgeMap.get(edgeId);
      if (!edge) continue;
      const nextId = edge.from === current.id ? edge.to : edge.from;
      if (closed.has(nextId)) continue;
      const tentative = gScore.get(current.id)! + edge.length;
      if (tentative < (gScore.get(nextId) ?? Infinity)) {
        gScore.set(nextId, tentative);
        cameFrom.set(nextId, current.id);
        const node = nodeMap.get(nextId);
        const h = node ? Math.abs(node.lat - nodeMap.get(destId)!.lat) * 111000 +
          Math.abs(node.lng - nodeMap.get(destId)!.lng) * 111000 * Math.cos(node.lat * Math.PI / 180) : 0;
        open.push({ id: nextId, cost: tentative, heuristic: h });
      }
    }
  }
  return null;
}
