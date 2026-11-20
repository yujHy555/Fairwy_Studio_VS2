import { defineConfig, Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

function defaultHoleApiPlugin(): Plugin {
  return {
    name: 'default-hole-api',
    configureServer(server) {
      server.middlewares.use('/api/save-default-hole', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const defaultHolePath = path.resolve(__dirname, 'public/default_hole.json');
              fs.writeFileSync(defaultHolePath, body, 'utf8');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: false, error: err?.message }));
            }
          });
        } else {
          res.statusCode = 405;
          res.end('Method Not Allowed');
        }
      });

      server.middlewares.use('/api/reset-default-hole', (req, res) => {
        if (req.method === 'POST') {
          try {
            const defaultHolePath = path.resolve(__dirname, 'public/default_hole.json');
            if (fs.existsSync(defaultHolePath)) {
              fs.unlinkSync(defaultHolePath);
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: err?.message }));
          }
        } else {
          res.statusCode = 405;
          res.end('Method Not Allowed');
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [defaultHoleApiPlugin()],
  server: {
    host: true,
    port: 5173
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok']
  },
  build: {
    target: 'esnext'
  }
});

