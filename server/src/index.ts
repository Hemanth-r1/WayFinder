import express from 'express';
import { getGraph } from './graphService.js';

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/graph', async (_req, res) => {
  try {
    const result = await getGraph();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, () => {
  console.log(`[WayFinder Server] Listening on ${PORT}`);
});
