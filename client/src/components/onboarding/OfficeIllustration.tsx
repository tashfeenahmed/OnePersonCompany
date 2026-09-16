import officeTeam from "@/assets/onboarding/office-team.webp";

/** Static artwork keeps the welcome screen light and works without WebGL. */
export function OfficeIllustration() {
  return (
    <img
      className="ob-office-illustration"
      src={officeTeam}
      alt="A founder and four AI assistants collaborating on research, analytics, code and design in a colorful office."
      width={1200}
      height={1200}
      decoding="async"
      fetchPriority="high"
    />
  );
}
