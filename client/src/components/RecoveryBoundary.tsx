import { Component, type ReactNode } from "react";
export class RecoveryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="mx-auto max-w-xl p-8 space-y-4" role="alert">
      <h1 className="text-2xl">This page could not load</h1>
      <p>Your server data is still saved. Reload, or download your browser preferences before clearing the cached copy.</p>
      <button className="border rounded p-2" onClick={() => location.reload()}>Reload</button>{" "}
      <button className="border rounded p-2" onClick={() => {
        const data = localStorage.getItem("opc-state-v5") ?? localStorage.getItem("opc-invalid-workspace") ?? "{}";
        const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
        const a = document.createElement("a"); a.href = url; a.download = "workspace-recovery.json"; a.click(); URL.revokeObjectURL(url);
      }}>Download recovery copy</button>{" "}
      <button className="border rounded p-2" onClick={() => {
        if (!confirm("Clear this browser's cached preferences and reload from the server?")) return;
        const raw = localStorage.getItem("opc-state-v5"); if (raw) localStorage.setItem("opc-invalid-workspace", raw);
        localStorage.removeItem("opc-state-v5"); location.assign("/");
      }}>Reload preferences from server</button>
    </main>;
  }
}
