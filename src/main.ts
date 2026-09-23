import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ErrorsFilter } from './common/errors.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', 1); // behind Railway's proxy: req.ip is the caller, not the proxy
  app.use(helmet());
  app.useGlobalFilters(new ErrorsFilter());
  app.enableShutdownHooks();
  // No CORS: no browser calls this API. The portal calls it server to server.
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
