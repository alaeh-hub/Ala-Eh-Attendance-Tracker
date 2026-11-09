import Icon from "../../components/Icon";
import type { Step } from "./poses";

export default function Stepper({ step }: { step: Step }) {
  const steps = ["Employee details", "Face capture", "Complete"];
  return (
    <ol className="mb-8 flex items-center gap-2 sm:gap-4 animate-fade-up">
      {steps.map((label, i) => {
        const n = (i + 1) as Step;
        const done = step > n;
        const active = step === n;
        return (
          <li key={label} className="flex flex-1 items-center gap-2 sm:gap-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-colors duration-300 ${
                done ? "bg-brand-500 text-black" : active ? "bg-brand-500/15 text-brand-300 ring-2 ring-brand-500" : "bg-white/[0.05] text-neutral-500"
              }`}
            >
              {done ? <Icon name="check" className="h-4 w-4" strokeWidth={3} /> : n}
            </span>
            <span className={`hidden text-sm font-semibold sm:block ${active ? "text-white" : done ? "text-neutral-300" : "text-neutral-500"}`}>{label}</span>
            {i < steps.length - 1 && <span className={`h-px flex-1 transition-colors duration-500 ${done ? "bg-brand-500" : "bg-white/10"}`} />}
          </li>
        );
      })}
    </ol>
  );
}
