import { Simulator } from "./Simulator";

export default function SimulatorPage() {
  return (
    <main className="wrap">
      <p><a href="/dashboard">← Dashboard</a></p>
      <h1>Text simulator</h1>
      <p className="note">Play the caller. This runs the real agent and classifier, but nothing is saved and nothing is sent to Telegram.</p>
      <Simulator />
    </main>
  );
}
