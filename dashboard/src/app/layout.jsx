import "./globals.css";
import { MonitorProvider } from "../context/MonitorContext";
import { PinAuthProvider } from "../context/PinAuthContext";
import Sidebar from "../components/Sidebar";
import PinLock from "../components/PinLock";

export const metadata = {
  title: "Watson Control Tower — Parental Monitor",
  description: "Real-time parental monitoring dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <PinAuthProvider>
          <PinLock>
            <MonitorProvider>
              <div className="appShell">
                <Sidebar />
                <main className="appMain">
                  {children}
                </main>
              </div>
            </MonitorProvider>
          </PinLock>
        </PinAuthProvider>
      </body>
    </html>
  );
}
