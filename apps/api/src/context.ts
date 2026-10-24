import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import type { AdapterRegistry } from './integrations/registry.js';
import type { IntegrationService } from './services/integrations.js';
import type { NotificationService } from './services/notifications.js';
import type { SecretStore } from './services/secrets.js';

export interface Deps {
  config: AppConfig;
  db: Db;
  secrets: SecretStore;
  registry: AdapterRegistry;
  integrations: IntegrationService;
  notifications: NotificationService;
  now: () => Date;
}

export interface Actor {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}
