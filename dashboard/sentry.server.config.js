import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://fddd735a7f34b2610c756944c1518ce9@o4511237536677888.ingest.us.sentry.io/4511237539561472",

  sendDefaultPii: true,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Attach local variable values to stack frames
  includeLocalVariables: true,

  enableLogs: true,
});
