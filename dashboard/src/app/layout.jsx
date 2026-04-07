import "./globals.css";
import { MonitorProvider } from "../context/MonitorContext";
import Sidebar from "../components/Sidebar";

export const metadata = {
  title: "Watson Control Tower — Parental Monitor",
  description: "Real-time parental monitoring dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <MonitorProvider>
          <div style={{ display: "flex", height: "100dvh", overflow: "hidden" }}>
            <Sidebar />
            <main
              style={{
                flex: 1,
                overflowY: "auto",
                background: "var(--bg-mesh)",
                backgroundAttachment: "fixed",
              }}
            >
              {children}
            </main>
          </div>
        </MonitorProvider>
      </body>
    </html>
  );
}
