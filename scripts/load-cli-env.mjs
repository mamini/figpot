import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

const envFiles = ['.env', '.env.test', '.env.local'];

for (const envFile of envFiles) {
  const envFilePath = path.resolve(process.cwd(), envFile);

  if (fs.existsSync(envFilePath)) {
    dotenv.config({ path: envFilePath, override: true });
  }
}

for (const envFile of envFiles) {
  const envFilePath = path.resolve(process.cwd(), envFile);

  if (fs.existsSync(envFilePath)) {
    dotenv.config({ path: envFilePath, override: true });
  }
}