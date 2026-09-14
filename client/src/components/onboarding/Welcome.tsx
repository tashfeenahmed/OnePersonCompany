import {
  ArrowRight,
  Grid2X2,
  FolderPlus,
  Cable,
  Bot,
  Network,
} from "lucide-react";
import { OfficeIllustration } from "./OfficeIllustration";

const steps = [
  {
    icon: Grid2X2,
    title: "Create your workspace",
    detail: "One place to run your company.",
  },
  {
    icon: FolderPlus,
    title: "Add your first venture",
    detail: "Start with one, or add it later.",
  },
  {
    icon: Cable,
    title: "Connect your services",
    detail: "Paste your keys together in one ENV file.",
  },
  {
    icon: Bot,
    title: "Choose your assistant",
    detail: "Hermes or OpenClaw, with your preferred LLM.",
  },
  {
    icon: Network,
    title: "Sub-agents, automatically created",
    detail: "A team of specialists for each venture.",
  },
];

export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <main className="ob-welcome">
      <div className="ob-welcome-copy">
        <div className="ob-eyebrow">Welcome to your next chapter</div>
        <h1 tabIndex={-1}>
          Your company.
          <br />
          One workspace.
        </h1>
        <p className="ob-welcome-intro">
          Bring your ventures, services and assistant together.
        </p>
        <ol className="ob-welcome-steps">
          {steps.map(({ icon: Icon, title, detail }, index) => (
            <li key={title} style={{ animationDelay: `${160 + index * 65}ms` }}>
              <span className="ob-welcome-step-icon">
                <Icon size={17} strokeWidth={1.5} />
              </span>
              <div>
                <strong>{title}</strong>
                <p>{detail}</p>
              </div>
            </li>
          ))}
        </ol>
        <button className="ob-primary" onClick={onStart}>
          Let’s set up <ArrowRight size={16} />
        </button>
        <p className="ob-welcome-note">
          Start small. Add more whenever you’re ready.
        </p>
      </div>
      <div className="ob-welcome-visual">
        <OfficeIllustration />
      </div>
    </main>
  );
}
