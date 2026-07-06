import { VadSettings, SystemAudioContext } from "./components";
import { PageLayout } from "@/layouts";

const Voice = () => {
  return (
    <PageLayout
      title="Voice"
      description="Configure system-audio recording and the AI context for transcriptions"
    >
      <VadSettings />
      <SystemAudioContext />
    </PageLayout>
  );
};

export default Voice;
