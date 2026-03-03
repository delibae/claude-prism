import {
  Dna,
  FlaskConical,
  HeartPulse,
  BarChart3,
  Brain,
  BookOpen,
  Microscope,
  Settings,
  Atom,
  Activity,
  Scan,
  Gem,
  Telescope,
  Pipette,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";

export interface SkillEntryData {
  name: string;
  folder: string;
}

export interface SkillCategoryData {
  id: string;
  name: string;
  icon: string;
  skill_count: number;
  skills: SkillEntryData[];
}

export const ICON_MAP: Record<string, LucideIcon> = {
  dna: Dna,
  "flask-conical": FlaskConical,
  "heart-pulse": HeartPulse,
  "bar-chart-3": BarChart3,
  brain: Brain,
  "book-open": BookOpen,
  microscope: Microscope,
  settings: Settings,
  atom: Atom,
  activity: Activity,
  scan: Scan,
  gem: Gem,
  telescope: Telescope,
  pipette: Pipette,
  helix: Dna,
  lightbulb: Lightbulb,
};

// Monotone — all categories use the same foreground-derived color.
// The constant is kept so existing look-ups (ACCENT_COLORS[id]) keep working;
// the value is intentionally a single neutral tone that adapts via opacity.
const MONO = "currentColor";

export const ACCENT_COLORS: Record<string, string> = {
  bioinformatics: MONO,
  cheminformatics: MONO,
  clinical: MONO,
  "data-analysis": MONO,
  "ml-ai": MONO,
  "scientific-communication": MONO,
  "multi-omics": MONO,
  engineering: MONO,
  proteomics: MONO,
  "healthcare-ai": MONO,
  "medical-imaging": MONO,
  "materials-science": MONO,
  "physics-astronomy": MONO,
  "lab-automation": MONO,
  "protein-engineering": MONO,
  "research-methodology": MONO,
};
