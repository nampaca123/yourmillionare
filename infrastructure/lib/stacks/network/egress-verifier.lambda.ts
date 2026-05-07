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
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Request timeout')); });
    req.end();
  });

  console.info(JSON.stringify({ message: 'NAT egress verified', publicIp }));
  return { publicIp, status: 'ok' };
};
