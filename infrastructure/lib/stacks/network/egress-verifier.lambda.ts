// Egress verifier: invocable Lambda to verify NAT instance outbound connectivity.

import { request } from 'https';

const TARGET_URL = 'https://api.ipify.org/?format=json';

export const handler = async (): Promise<{ publicIp: string; status: 'ok' }> => {
  const publicIp = await new Promise<string>((resolve, reject) => {
    const req = request(TARGET_URL, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { ip: string };
          resolve(parsed.ip);
        } catch {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Request timeout')); });
    req.end();
  });

  process.stdout.write(JSON.stringify({ message: 'NAT egress verified', publicIp }) + '\n');
  return { publicIp, status: 'ok' };
};
