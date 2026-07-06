import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import {
  App,
  SystemPrompts,
  ViewChat,
  Settings,
  DevSpace,
  Shortcuts,
  Audio,
  Screenshot,
  Chats,
  Responses,
  Voice,
} from "@/pages";
import { DashboardLayout } from "@/layouts";

export default function AppRoutes() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<App />} />
        <Route element={<DashboardLayout />}>
          <Route path="/chats" element={<Chats />} />
          <Route path="/system-prompts" element={<SystemPrompts />} />
          <Route path="/chats/view/:conversationId" element={<ViewChat />} />
          <Route path="/shortcuts" element={<Shortcuts />} />
          <Route path="/screenshot" element={<Screenshot />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/audio" element={<Audio />} />
          <Route path="/voice" element={<Voice />} />
          <Route path="/responses" element={<Responses />} />
          <Route path="/dev-space" element={<DevSpace />} />
        </Route>
      </Routes>
    </Router>
  );
}
