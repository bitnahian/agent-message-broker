import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, type BrokerEvent, type Session, type Source, type Subscription, type Topic } from "./api";
import { SignalPulse } from "./assets/illustrations";

const AGENTS = ["pi", "claude", "codex"] as const;

const inputCls = "bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 transition-colors placeholder:text-zinc-600";
const btnCls = "bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-md px-4 py-2 text-sm font-medium transition-colors";
const btnSmCls = "bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 rounded-md px-3 py-1.5 text-xs font-medium transition-colors";
const badgeCls = "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium";
const AGENT_LAUNCH_HINTS: Record<string, string> = {
  pi: "Start the pi-intercom broker using `pi` or `npx pi`",
  claude: "Start a session with `claude` in your project directory",
  codex: "Start a session with `codex` in your project directory",
};
const AGENT_COLORS: Record<string, string> = {
  pi: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30",
  claude: "bg-amber-500/10 text-amber-400 border border-amber-500/30",
  codex: "bg-purple-500/10 text-purple-400 border border-purple-500/30",
};
const AGENT_NAMES: Record<string, string> = { pi: "pi", claude: "Claude", codex: "Codex" };
const KIND_LABELS: Record<string, string> = { "polled-url": "Polled URL", github: "GitHub", jira: "Jira", google: "Google Workspace" };
const KIND_EXAMPLES: Record<string, string> = {
  "polled-url": '{"url": "https://example.com/file.txt", "intervalMs": 30000}',
  github: '{"repo": "owner/repo", "resource": "events", "intervalMs": 60000}',
  jira: '{"jql": "project = KAN ORDER BY updated DESC", "intervalMs": 120000}',
  google: '{"api": "drive.files.list", "params": {"q": "trashed = false", "pageSize": 10}, "itemsPath": "files", "fingerprintField": "modifiedTime"}',
};
// Per-resource option examples for the github kind (ADR-0008)
const GITHUB_RESOURCE_EXAMPLES: Record<string, string> = {
  events: '{"repo": "owner/repo", "resource": "events", "eventTypes": ["PullRequestEvent"], "intervalMs": 60000}',
  search: '{"repo": "owner/repo", "resource": "search", "queries": [{"name": "my-prs", "q": "is:pr is:open author:me"}], "intervalMs": 120000}',
  pulls: '{"repo": "owner/repo", "resource": "pulls", "prs": [142], "include": ["comments", "reviews", "inline-comments", "ci", "state", "head"], "intervalMs": 60000}',
};
const GITHUB_RESOURCE_LABELS: Record<string, string> = {
  events: "Resource: events (repo activity feed)",
  search: "Resource: search (saved queries)",
  pulls: "Resource: pulls (track specific PRs)",
};

// ── Toast system ──
interface Toast { id: string; message: string; detail?: string; type: "success" | "error" | "info" }
const ToastCtx = createContext<{ add: (msg: string, type: Toast["type"], detail?: string) => void } | null>(null);
function useToast() { const ctx = useContext(ToastCtx); if (!ctx) throw new Error("missing ToastCtx"); return ctx; }

function ToastContainer({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const add = useCallback((message: string, type: Toast["type"], detail?: string) => {
    const id = String(++idRef.current);
    setToasts((prev) => [...prev, { id, message, detail, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx value={{ add }}>
      {children}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id}
            className={`pointer-events-auto px-4 py-3 rounded-lg shadow-lg border text-sm transition-all duration-300 ${t.type === "success" ? "bg-emerald-900/90 border-emerald-700 text-emerald-100" : t.type === "error" ? "bg-red-900/90 border-red-700 text-red-100" : "bg-zinc-800/90 border-zinc-700 text-zinc-200"}`}>
            <div className="font-medium">{t.message}</div>
            {t.detail && <p className="text-xs opacity-80 mt-1">{t.detail}</p>}
          </div>
        ))}
      </div>
    </ToastCtx>
  );
}

// ── helpers ──
function Help({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-xs text-zinc-500 ${className ?? ""}`}>{children}</p>;
}
function Empty({ text, className }: { text: string; className?: string }) {
  return <p className={`text-zinc-500 text-sm py-6 text-center ${className ?? ""}`}>{text}</p>;
}
function formatDate(ts: number) {
  const d = new Date(ts); const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function useRefreshInterval(fn: () => void, ms: number) {
  const fnRef = useRef(fn); fnRef.current = fn;
  useEffect(() => { fnRef.current(); const i = setInterval(() => fnRef.current(), ms); return () => clearInterval(i); }, [ms]);
}
function useCatchToast() {
  const toast = useToast();
  return useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const friendly = msg.includes("401") ? "Authentication failed" : msg.includes("404") ? "Not found" : msg.includes("409") ? "Already exists" : msg.includes("ECONNREFUSED") ? "Broker unreachable" : msg.includes("fetch failed") ? "Connection failed" : "Request failed";
    const detail = msg.includes("ECONNREFUSED") ? "Run npm run start to start the broker" : msg.includes("401") ? "Your auth token may have expired" : msg.includes("404") ? "The session may have exited" : msg.includes("409") ? "A duplicate already exists" : undefined;
    toast.add(friendly, "error", detail);
  }, [toast]);
}

// ── Topic sidebar item ──
function TopicItem({ topic, active, onClick, onDelete }: { topic: Topic; active: boolean; onClick: () => void; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div onClick={onClick} className={`group flex items-center justify-between px-4 py-3 cursor-pointer border-b border-zinc-800/50 transition-colors ${active ? "bg-indigo-600/20 border-l-2 border-l-indigo-500" : "hover:bg-zinc-800/50 border-l-2 border-l-transparent"}`}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{topic.name}</div>
        <div className="text-xs text-zinc-500">retain {topic.retainN}</div>
      </div>
      {!confirming ? (
        <button className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 ml-2 p-1 rounded transition-all text-sm" title={`Delete topic "${topic.name}"`} aria-label={`Delete ${topic.name}`}
          onClick={(e) => { e.stopPropagation(); setConfirming(true); }}>✕</button>
      ) : (
        <button className="text-red-400 hover:text-red-300 ml-2 px-2 py-1 text-xs rounded border border-red-500/30 hover:bg-red-500/10 transition-colors"
          onClick={(e) => { e.stopPropagation(); onDelete(); setConfirming(false); }}>Confirm</button>
      )}
    </div>
  );
}

// ── Topic detail ──
function TopicDetail({ topic, sources, subs, sessions, refresh, refreshSessions }: { topic: Topic; sources: Source[]; subs: Subscription[]; sessions: Session[]; refresh: () => void; refreshSessions: () => void }) {
  const [activeTab, setActiveTab] = useState<"events" | "sources" | "subs">("events");
  useRefreshInterval(refreshSessions, 15000);
  const topicSources = sources.filter((s) => s.topicId === topic.id);
  const topicSubs = subs.filter((s) => s.topicId === topic.id);
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-5 border-b border-zinc-800/50">
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-xl font-bold">{topic.name}</h2>
          <span className={badgeCls + " bg-zinc-800 text-zinc-400"}>retain {topic.retainN}</span>
          <span className={badgeCls + " bg-zinc-800 text-zinc-400"}>{topicSources.length} source{topicSources.length !== 1 ? "s" : ""}</span>
          <span className={badgeCls + " bg-zinc-800 text-zinc-400"}>{topicSubs.length} subscriber{topicSubs.length !== 1 ? "s" : ""}</span>
        </div>
        <Help>{topic.id}</Help>
      </div>
      <div className="flex gap-0 px-6 border-b border-zinc-800/50">
        {(["events", "sources", "subs"] as const).map((t) => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === t ? "border-indigo-500 text-zinc-200" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}>
            {t === "events" ? "Events" : t === "sources" ? "Sources" : "Subscriptions"}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === "events" && <TopicEvents topic={topic} />}
        {activeTab === "sources" && <TopicSources topic={topic} sources={topicSources} refresh={refresh} />}
        {activeTab === "subs" && <TopicSubs topic={topic} subs={topicSubs} sessions={sessions} refresh={refresh} refreshSessions={refreshSessions} />}
      </div>
    </div>
  );
}

// ── Events tab ──
function TopicEvents({ topic }: { topic: Topic }) {
  const [events, setEvents] = useState<BrokerEvent[]>([]);
  const [pubKind, setPubKind] = useState("test:manual");
  const [pubPayload, setPubPayload] = useState('{"hello": "world"}');
  const [publishing, setPublishing] = useState(false);
  const [retained, setRetained] = useState<BrokerEvent[]>([]);
  const [showRetained, setShowRetained] = useState(false);
  const streamRef = useRef<EventSource | null>(null);
  const catchErr = useCatchToast();
  const toast = useToast();

  useEffect(() => {
    streamRef.current?.close();
    const es = new EventSource(`/events/stream?replay=1&topicId=${topic.id}`);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as BrokerEvent; if (ev.topicId !== topic.id) return;
        setEvents((prev) => (prev.some((x) => x.id === ev.id) ? prev : [ev, ...prev].slice(0, 200)));
      } catch { /* */ }
    };
    streamRef.current = es;
    return () => { es.close(); setEvents([]); };
  }, [topic.id]);

  const loadRetained = useCallback(async () => { try { setRetained(await api.events(topic.id, 200)); } catch (err) { catchErr(err); } }, [topic.id, catchErr]);
  useEffect(() => { if (showRetained) loadRetained(); }, [showRetained, loadRetained]);

  const handlePublish = async () => {
    setPublishing(true); try { await api.publishEvent(topic.id, pubKind, JSON.parse(pubPayload)); toast.add(`Event published: ${pubKind}`, "success"); } catch (err) { catchErr(err); } finally { setPublishing(false); }
  };

  const showEvents = showRetained ? retained : events;
  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button className={btnSmCls} onClick={() => { setShowRetained((v) => !v); if (!showRetained) loadRetained(); }}>
          {showRetained ? "Live feed" : `Browse retained (${events.length})`}
        </button>
        <Help className="!mb-0">{showRetained ? "Live SSE feed" : "Past retained events"}</Help>
      </div>
      <details className="mb-4">
        <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 decoration-zinc-700 transition-colors">Publish event</summary>
        <div className="mt-3 p-4 border border-zinc-800 rounded-lg bg-zinc-900/50 space-y-3">
          <input className={inputCls} placeholder="Kind (e.g. test:manual)" value={pubKind} onChange={(e) => setPubKind(e.target.value)} />
          <textarea className={`${inputCls} h-20 font-mono text-sm`} placeholder='{"key": "value"}' value={pubPayload} onChange={(e) => setPubPayload(e.target.value)} />
          <button className={btnCls} disabled={publishing} onClick={handlePublish}>{publishing ? "Publishing..." : "Publish"}</button>
        </div>
      </details>
      {showRetained && !retained.length && <Help className="text-center py-4">Loading...</Help>}
      {showEvents.length === 0 && !showRetained ? <Empty text="No events yet." /> : (
        <div className="space-y-0.5 font-mono text-xs">
          {showEvents.map((e) => (
            <div key={e.id} className="flex items-start gap-3 py-2 px-3 rounded-lg hover:bg-zinc-800/30 border-b border-zinc-800/30 last:border-0 transition-colors">
              <span className="text-zinc-500 whitespace-nowrap pt-px">{formatDate(e.detectedAt)}</span>
              <span className={`inline-flex rounded-full px-1.5 py-0 text-xs font-medium ${e.kind.startsWith("test:") ? "bg-amber-500/10 text-amber-400 border border-amber-500/30" : e.kind.includes("error") ? "bg-red-500/10 text-red-400 border border-red-500/30" : "bg-blue-500/10 text-blue-400 border border-blue-500/30"}`}>
                {e.kind.slice(0, 20)}
              </span>
              <span className="text-zinc-300 break-all">{JSON.stringify(e.payload).slice(0, 300)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Confirm button (two-step) ──
function ConfirmButton({ label, confirmLabel = "confirm", onConfirm, disabled }: { label: string; confirmLabel?: string; onConfirm: () => void; disabled?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <div className="flex items-center gap-2 shrink-0">
        <button className="bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 rounded px-2 py-1 text-xs text-red-400" disabled={disabled} onClick={onConfirm}>{confirmLabel}</button>
        <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setConfirming(false)}>cancel</button>
      </div>
    );
  }
  return <button className="bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 rounded px-2 py-1 text-xs text-red-400" disabled={disabled} onClick={() => setConfirming(true)}>{label}</button>;
}

// ── Sources tab ──
function TopicSources({ topic, sources, refresh }: { topic: Topic; sources: Source[]; refresh: () => void }) {
  const [kind, setKind] = useState("polled-url");
  const [ghResource, setGhResource] = useState("events");
  const [options, setOptions] = useState(KIND_EXAMPLES["polled-url"]);
  const [running, setRunning] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const catchErr = useCatchToast();
  const toast = useToast();

  const refreshRunning = useCallback(async () => { try { setRunning((await api.runningSources()).running); } catch { /* */ } }, []);
  useRefreshInterval(refreshRunning, 10000);
  const handleCreate = async () => { setCreating(true); try { await api.createSource(topic.id, kind, JSON.parse(options)); refresh(); toast.add("Source created", "success"); } catch (err) { catchErr(err); } finally { setCreating(false); } };
  const handleDelete = async (id: string) => { setDeletingId(id); try { await api.deleteSource(id); refresh(); toast.add("Source deleted", "info"); } catch (err) { catchErr(err); } finally { setDeletingId(""); } };
  return (
    <div>
      <details className="mb-5" open={sources.length === 0}>
        <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-300 underline underline-offset-2 decoration-zinc-700 transition-colors">Add source</summary>
        <div className="mt-3 p-4 border border-zinc-800 rounded-lg bg-zinc-900/50 space-y-3">
          <select className={inputCls} value={kind} onChange={(e) => { setKind(e.target.value); if (e.target.value === "github") { setGhResource("events"); setOptions(GITHUB_RESOURCE_EXAMPLES.events); } else setOptions(KIND_EXAMPLES[e.target.value] ?? "{}"); }}>
            <option value="polled-url">Polled URL</option><option value="github">GitHub</option><option value="jira">Jira</option><option value="google">Google Workspace</option>
          </select>
          {kind === "github" && (
            <select className={inputCls} value={ghResource} aria-label="GitHub resource" onChange={(e) => { setGhResource(e.target.value); setOptions(GITHUB_RESOURCE_EXAMPLES[e.target.value]); }}>
              <option value="events">{GITHUB_RESOURCE_LABELS.events}</option>
              <option value="search">{GITHUB_RESOURCE_LABELS.search}</option>
              <option value="pulls">{GITHUB_RESOURCE_LABELS.pulls}</option>
            </select>
          )}
          <textarea className={`${inputCls} h-24 font-mono text-sm`} value={options} onChange={(e) => setOptions(e.target.value)} />
          <button className={btnCls} disabled={creating} onClick={handleCreate}>{creating ? "Creating..." : "Create source"}</button>
        </div>
      </details>
      {sources.length === 0 ? <Empty text="No sources yet." /> : (
        <div className="space-y-2">
          {sources.map((s) => {
            const isRunning = running.includes(s.id);
            const status = s.status ?? (isRunning ? "running" : "stopped");
            const running_ = status === "running";
            const failed = status === "auth-failed" || status === "errored";
            const statusCls = running_
              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
              : failed
                ? "bg-red-500/10 text-red-400 border border-red-500/30"
                : "bg-zinc-800 text-zinc-500 border border-zinc-700/50";
            return (
              <div key={s.id} className="flex items-center justify-between gap-4 p-3 rounded-lg border border-zinc-800/50 bg-zinc-900/30">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{KIND_LABELS[s.kind] ?? s.kind}</span>
                    <span className={`inline-flex rounded-full px-1.5 py-0 text-xs font-medium ${statusCls}`}>{status}</span>
                  </div>
                  <div className="text-xs text-zinc-600 mt-0.5">{s.id}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!running_ ? <button className="text-emerald-400 text-xs px-2 py-1 rounded border border-emerald-500/30 hover:bg-emerald-500/10" onClick={() => api.startSource(s.id).then(refreshRunning).catch(catchErr)}>Start</button>
                    : <button className="text-amber-400 text-xs px-2 py-1 rounded border border-amber-500/30 hover:bg-amber-500/10" onClick={() => api.stopSource(s.id).then(refreshRunning).catch(catchErr)}>Stop</button>}
                  <ConfirmButton label="Delete" onConfirm={() => handleDelete(s.id)} disabled={deletingId === s.id} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Subs tab ──
function TopicSubs({ topic, subs, sessions, refresh, refreshSessions }: { topic: Topic; subs: Subscription[]; sessions: Session[]; refresh: () => void; refreshSessions: () => void }) {
  const [agent, setAgent] = useState("pi");
  const [sessionId, setSessionId] = useState("");
  const [template, setTemplate] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [newSubId, setNewSubId] = useState("");
  const catchErr = useCatchToast();
  const toast = useToast();

  useRefreshInterval(refreshSessions, 15000);
  const reachable = sessions.filter((s) => s.reachable && s.sessionId);
  const agentSessions = reachable.filter((s) => s.agent === agent);
  const existingSessionIds = new Set(subs.map((s) => s.target.sessionId));

  const handleSubscribe = async () => {
    if (!sessionId.trim()) return;
    setCreating(true);
    try {
      const created = await api.createSubscription(topic.id, agent, sessionId.trim(), template || undefined);
      setSessionId(""); setNewSubId(created.id);
      toast.add(`${AGENT_NAMES[agent] ?? agent} subscribed`, "success", `Session: ${sessionId.slice(0, 16)}...`);
      await refresh();
      setTimeout(() => setNewSubId(""), 3000);
    } catch (err) { catchErr(err); }
    finally { setCreating(false); }
  };

  const handleDelete = async (id: string) => { setDeletingId(id); try { await api.deleteSubscription(id); await refresh(); toast.add("Subscription deleted", "info"); } catch (err) { catchErr(err); } finally { setDeletingId(""); } };

  return (
    <div>
      <details className="mb-5" open={subs.length === 0}>
        <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-300 underline underline-offset-2 decoration-zinc-700 transition-colors">Subscribe agent</summary>
        <div className="mt-3 p-4 border border-zinc-800 rounded-lg bg-zinc-900/50 space-y-3">
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Agent</label>
            <div className="flex gap-2">
              {AGENTS.map((a) => (
                <button key={a} onClick={() => { setAgent(a); setSessionId(""); }}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${agent === a ? `ring-1 ring-inset ${a === "pi" ? "bg-emerald-500/20 text-emerald-400 ring-emerald-500/40" : a === "claude" ? "bg-amber-500/20 text-amber-400 ring-amber-500/40" : "bg-purple-500/20 text-purple-400 ring-purple-500/40"}` : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>
                  {AGENT_NAMES[a]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Session</label>
            {agentSessions.length > 0 ? (
              <div className="space-y-1 mb-2 max-h-40 overflow-y-auto">
                {agentSessions.filter((s) => !existingSessionIds.has(s.sessionId)).map((s) => (
                  <button key={s.sessionId} onClick={() => setSessionId(s.sessionId)}
                    className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${sessionId === s.sessionId ? "bg-indigo-600/20 border border-indigo-500/30 text-indigo-300" : "bg-zinc-800/50 border border-zinc-800 hover:border-zinc-700 text-zinc-400"}`}>
                    <div className="font-medium">{s.label ?? s.sessionId}</div>
                    <div className="text-xs text-zinc-600">{s.sessionId.slice(0, 16)}</div>
                  </button>
                ))}
                {agentSessions.every((s) => existingSessionIds.has(s.sessionId)) && agentSessions.length > 0 && (
                  <p className="text-xs text-zinc-500 px-1 py-2">All {agent} sessions already subscribed.</p>
                )}
              </div>
            ) : (
              <div>
                <input className={inputCls} placeholder={`Paste ${agent} session ID`} value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
                <Help className="mt-1">{AGENT_LAUNCH_HINTS[agent] ?? ""}</Help>
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Template (optional)</label>
            <input className={inputCls} placeholder='e.g. Event {{kind}}: {{payload}}' value={template} onChange={(e) => setTemplate(e.target.value)} />
          </div>
          <button className={btnCls} disabled={creating || !sessionId.trim()} onClick={handleSubscribe}>{creating ? "Subscribing..." : "Subscribe"}</button>
        </div>
      </details>
      {subs.length === 0 ? <Empty text="No subscriptions yet." /> : (
        <div className="space-y-2">
          {subs.map((s) => {
            const isNew = newSubId === s.id;
            return (
              <div key={s.id} className={`flex items-center justify-between gap-4 p-3 rounded-lg border transition-all duration-500 ${isNew ? "border-emerald-500/50 bg-emerald-500/5" : "border-zinc-800/50 bg-zinc-900/30"}`}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`${badgeCls} ${AGENT_COLORS[s.target.agent] ?? "bg-zinc-800 text-zinc-400"}`}>{AGENT_NAMES[s.target.agent] ?? s.target.agent}</span>
                  <span className="text-sm text-zinc-400 truncate" title={s.target.sessionId}>{s.target.label ?? s.target.sessionId.slice(0, 16)}</span>
                  {s.template && <span className="text-xs text-zinc-600 truncate max-w-[200px]" title={s.template}>template: {s.template}</span>}
                  {isNew && <span className="text-xs text-emerald-400 font-medium">just subscribed</span>}
                </div>
                <ConfirmButton label="Delete" onConfirm={() => handleDelete(s.id)} disabled={deletingId === s.id} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Launchpad (first-run empty state) ──
function Launchpad({ onCreateTopic }: { onCreateTopic: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        <div className="flex flex-col items-center text-center mb-8">
          <SignalPulse className="w-48 h-28 mb-4 opacity-80" />
          <h2 className="text-xl font-bold mb-2">The Local Exchange</h2>
          <p className="text-sm text-zinc-500 max-w-md">Wire event sources to your coding agents in three steps. Everything flows through one place.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {[
            { n: "1", title: "Create a topic", body: "A named channel for events. Add it in the sidebar to get started.", color: "border-zinc-700 text-zinc-400" },
            { n: "2", title: "Add a source", body: "Point a source at a feed — URL, GitHub, Jira, or Workspace — and start it.", color: "border-indigo-500/30 text-indigo-300" },
            { n: "3", title: "Subscribe an agent", body: "Pick a running pi, Claude, or Codex session. Events steer it reactively.", color: "border-emerald-500/30 text-emerald-300" },
          ].map((s) => (
            <div key={s.n} className="p-4 rounded-lg border bg-zinc-900/30">
              <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold mb-3 ${s.color}`}>{s.n}</span>
              <div className="text-sm font-medium mb-1">{s.title}</div>
              <p className="text-xs text-zinc-500 leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
        <div className="text-center">
          <button className={btnCls} onClick={onCreateTopic}>Create your first topic</button>
          <p className="text-xs text-zinc-600 mt-3">Or type a name in the sidebar and press Enter.</p>
        </div>
      </div>
    </div>
  );
}

// ── TopBar ──
function TopBar({ sessions, refreshSessions, throughput }: { sessions: Session[]; refreshSessions: () => void; throughput: number }) {
  const liveByAgent: Record<string, number> = {};
  for (const s of sessions) { if (s.reachable && s.sessionId) { liveByAgent[s.agent] = (liveByAgent[s.agent] ?? 0) + 1; } }
  const unreachable = sessions.filter((s) => s.sessionId === "" || !s.reachable);
  return (
    <div className="flex items-center gap-4 px-6 py-3 border-b border-zinc-800/50 bg-zinc-900/30 shrink-0">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-bold text-zinc-200 mr-auto">agent-message-broker</h1>
        {throughput > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-500" title="Events received in the last 30 seconds">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span>{throughput} in 30s</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {AGENTS.map((a) => (
          <span key={a} className={`${badgeCls} ${AGENT_COLORS[a]} ${!liveByAgent[a] ? "opacity-50" : ""}`}>{AGENT_NAMES[a]}: {(liveByAgent[a] ?? 0)}</span>
        ))}
        {unreachable.length > 0 && <span className={`${badgeCls} bg-red-500/10 text-red-400 border border-red-500/30`}>{unreachable.length} offline</span>}
        <button className={btnSmCls} onClick={refreshSessions} title="Refresh sessions" aria-label="Refresh sessions">Refresh</button>
      </div>
    </div>
  );
}

// ── App ──
function AppBody() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [offline, setOffline] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRetain, setNewRetain] = useState("100");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [eventCount, setEventCount] = useState(0);
  const toast = useToast();
  const catchErr = useCatchToast();
  const nameInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => { try { const [t, s, b] = await Promise.all([api.topics(), api.sources(), api.subscriptions()]); setTopics(t); setSources(s); setSubs(b); setOffline(false); } catch { setOffline(true); } }, []);
  const refreshSessions = useCallback(() => { api.sessions().then(setSessions).catch(() => {}); }, []);

  useRefreshInterval(refresh, 10000);
  useRefreshInterval(refreshSessions, 15000);

  // Global event throughput: count events seen in a rolling 30s window
  useEffect(() => {
    const es = new EventSource("/events/stream");
    let windowStart = Date.now();
    es.onmessage = () => {
      if (Date.now() - windowStart > 30_000) { windowStart = Date.now(); setEventCount(0); }
      setEventCount((c) => c + 1);
    };
    return () => es.close();
  }, []);

  const selectedTopic = topics.find((t) => t.id === selectedTopicId);
  const canCreate = newName.trim().length > 0 && Number.isFinite(parseInt(newRetain, 10)) && parseInt(newRetain, 10) > 0;
  const isFirstRun = topics.length === 0 && sources.length === 0 && subs.length === 0;

  const handleCreateTopic = useCallback(async () => {
    // No name typed yet (e.g. the launchpad button): guide the user to the input
    // instead of POSTing an empty name the server must reject.
    if (!newName.trim()) { nameInputRef.current?.focus(); return; }
    setCreating(true); setCreateError("");
    try {
      const t = await api.createTopic(newName.trim(), parseInt(newRetain, 10));
      setNewName(""); setNewRetain("100"); await refresh(); setSelectedTopicId(t.id);
      toast.add(`Topic "${t.name}" created`, "success");
    } catch (err) { catchErr(err); }
    finally { setCreating(false); }
  }, [newName, newRetain, refresh, toast, catchErr]);

  const deleteTopic = useCallback(async (id: string) => {
    try { await api.deleteTopic(id); if (selectedTopicId === id) setSelectedTopicId(""); await refresh(); toast.add("Topic deleted", "info"); } catch (err) { catchErr(err); }
  }, [selectedTopicId, refresh, toast]);

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {offline && (
        <div className="px-6 py-2 bg-red-900/30 border-b border-red-800 text-red-300 text-xs text-center">
          Broker server unreachable &mdash; is it running? (<code className="bg-red-950/50 px-1 rounded">npm run start</code>)
        </div>
      )}
      <TopBar sessions={sessions} refreshSessions={refreshSessions} throughput={eventCount} />
      <div className="flex-1 flex min-h-0">
        <aside className="w-64 shrink-0 border-r border-zinc-800/50 flex flex-col bg-zinc-950">
          <div className="p-4 border-b border-zinc-800/50 space-y-2">
            <input ref={nameInputRef} className={inputCls + " text-sm"} placeholder="New topic name..." value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && canCreate) handleCreateTopic(); }} />
            <div className="flex gap-2">
              <input className={`${inputCls} w-24 text-sm`} placeholder="retain" title="Events retained per topic" value={newRetain} onChange={(e) => setNewRetain(e.target.value)} />
              <button className={btnCls + " flex-1 text-sm"} disabled={!canCreate || creating} onClick={handleCreateTopic}>{creating ? "..." : "Create"}</button>
            </div>
            {createError && <p className="text-red-400 text-xs">{createError}</p>}
          </div>
          <div className="flex-1 overflow-y-auto">
            {topics.length === 0 ? <Empty text="No topics yet." /> : topics.map((t) => (
              <TopicItem key={t.id} topic={t} active={t.id === selectedTopicId} onClick={() => setSelectedTopicId(t.id)} onDelete={() => deleteTopic(t.id)} />
            ))}
          </div>
        </aside>
        <main className="flex-1 flex flex-col min-h-0">
          {selectedTopic
            ? <TopicDetail topic={selectedTopic} sources={sources} subs={subs} sessions={sessions} refresh={refresh} refreshSessions={refreshSessions} />
            : isFirstRun
              ? <Launchpad onCreateTopic={handleCreateTopic} />
              : <div className="flex-1 flex items-center justify-center">
                  <div className="text-center max-w-sm">
                    <h2 className="text-lg font-semibold mb-2">Select a topic</h2>
                    <p className="text-sm text-zinc-500">Choose a topic from the sidebar to see its events, sources, and subscriptions. Or create a new topic to get started.</p>
                  </div>
                </div>
          }
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <ToastContainer>
      <AppBody />
    </ToastContainer>
  );
}