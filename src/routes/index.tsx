import { lazy, Suspense } from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { App } from "@/pages";
import { DashboardLayout } from "@/layouts";

// The overlay (route "/") stays eagerly imported — it's the first thing shown
// and must render instantly. Every dashboard route is code-split with
// React.lazy so the overlay bundle no longer ships the entire dashboard
// (settings, dev space, chat views, markdown/mermaid renderers, etc.).
const Chats = lazy(() => import("@/pages/chats"));
const ViewChat = lazy(() => import("@/pages/chats/components/View"));
const SystemPrompts = lazy(() => import("@/pages/system-prompts"));
const Settings = lazy(() => import("@/pages/settings"));
const DevSpace = lazy(() => import("@/pages/dev"));
const Shortcuts = lazy(() => import("@/pages/shortcuts"));
const Audio = lazy(() => import("@/pages/audio"));
const Screenshot = lazy(() => import("@/pages/screenshot"));
const Responses = lazy(() => import("@/pages/responses"));
const Voice = lazy(() => import("@/pages/voice"));

export default function AppRoutes() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<App />} />
        <Route element={<DashboardLayout />}>
          <Route
            path="/chats"
            element={
              <Suspense fallback={null}>
                <Chats />
              </Suspense>
            }
          />
          <Route
            path="/system-prompts"
            element={
              <Suspense fallback={null}>
                <SystemPrompts />
              </Suspense>
            }
          />
          <Route
            path="/chats/view/:conversationId"
            element={
              <Suspense fallback={null}>
                <ViewChat />
              </Suspense>
            }
          />
          <Route
            path="/shortcuts"
            element={
              <Suspense fallback={null}>
                <Shortcuts />
              </Suspense>
            }
          />
          <Route
            path="/screenshot"
            element={
              <Suspense fallback={null}>
                <Screenshot />
              </Suspense>
            }
          />
          <Route
            path="/settings"
            element={
              <Suspense fallback={null}>
                <Settings />
              </Suspense>
            }
          />
          <Route
            path="/audio"
            element={
              <Suspense fallback={null}>
                <Audio />
              </Suspense>
            }
          />
          <Route
            path="/voice"
            element={
              <Suspense fallback={null}>
                <Voice />
              </Suspense>
            }
          />
          <Route
            path="/responses"
            element={
              <Suspense fallback={null}>
                <Responses />
              </Suspense>
            }
          />
          <Route
            path="/dev-space"
            element={
              <Suspense fallback={null}>
                <DevSpace />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </Router>
  );
}
