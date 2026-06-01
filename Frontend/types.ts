
export enum AccountStatus {
  PENDING = 'PENDING',
  VERIFYING = 'VERIFYING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  NO_ACTIVE = 'NO_ACTIVE',
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND'
}

export interface Account {
  id: string;
  email: string;
  password: string;
  status: AccountStatus;
  lastVerified?: string;
  otpCode?: string;
  collection?: string; // For grouping accounts under specific names
  createdAt?: string; // ISO timestamp when account was created
  verifiedBy?: string; // The user who verified the account
}

export interface AppSettings {
  proxiesEnabled: boolean;
  headlessMode: boolean;
  // API Settings
  cloudflareEmail?: string;
  cloudflareKey?: string;
  cloudflareZoneId?: string;
  telegramToken?: string;
  telegramChatId?: string;
  proxiesList?: string;
  // Hero-SMS Settings
  heroSmsKey?: string;
  heroSmsUrl?: string;
  // SFTP Settings
  sftpHost?: string;
  sftpPort?: string;
  sftpUser?: string;
  sftpPassword?: string;
  sftpPath?: string;
  // Captcha Settings
  captchaKey?: string;
  // Performance
  concurrency?: string;
  // AWS S3 Settings
  awsAccessKey?: string;
  awsSecretKey?: string;
  awsRegion?: string;
  awsBucket?: string;
  // Google Admin Settings
  adminEmail?: string;
  adminPassword?: string;
  // Registrar Settings
  namecheapKey?: string;
  namecheapUser?: string;
  namecheapIp?: string;
  spaceshipKey?: string;
  spaceshipSecret?: string;
  nicnamesKey?: string;
}

export type ViewType = 'DASHBOARD' | 'QUEUE' | 'OPERATIONS' | 'SETTINGS' | 'VALID_ACCOUNTS' | 'PHONE_VERIFY' | 'MANAGE_ACCOUNTS' | 'UPLOAD_JSON' | 'APP_PASSWORDS' | 'APP_USERS' | 'ONLINE_USERS' | 'ARCHIVE_ACCOUNTS' | 'CREATE_USERS' | 'DOMAINS' | 'MANUAL_OTP';
