import { InfoIcon, MicIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { Popover, PopoverContent, PopoverTrigger, Button } from "@/components";
import { UseCompletionReturn } from "@/types";
import { useApp } from "@/contexts";

// AutoSpeechVAD pulls in @ricky0123/vad-react + onnxruntime-web (~550 KB of
// WASM/JS) which are only needed when the mic VAD is actually active. Lazy-load
// it so that weight stays out of the initial overlay bundle and is fetched only
// when the user has a speech provider configured AND enables voice input.
const AutoSpeechVAD = lazy(() =>
  import("./AutoSpeechVad").then((m) => ({ default: m.AutoSpeechVAD }))
);

export const Audio = ({
  micOpen,
  setMicOpen,
  enableVAD,
  setEnableVAD,
  submit,
  setState,
}: UseCompletionReturn) => {
  const { selectedSttProvider, selectedAudioDevices } = useApp();

  const speechProviderStatus = selectedSttProvider.provider;

  return (
    <Popover open={micOpen} onOpenChange={setMicOpen}>
      <PopoverTrigger asChild>
        {speechProviderStatus && enableVAD ? (
          <Suspense
            fallback={
              <Button
                size="icon"
                className="cursor-pointer"
                title="Loading voice input…"
              >
                <MicIcon className="h-4 w-4 animate-pulse" />
              </Button>
            }
          >
            <AutoSpeechVAD
              key={selectedAudioDevices.input.id}
              submit={submit}
              setState={setState}
              setEnableVAD={setEnableVAD}
              microphoneDeviceId={selectedAudioDevices.input.id}
            />
          </Suspense>
        ) : (
          <Button
            size="icon"
            onClick={() => {
              setEnableVAD(!enableVAD);
            }}
            className="cursor-pointer"
            title="Toggle voice input"
          >
            <MicIcon className="h-4 w-4" />
          </Button>
        )}
      </PopoverTrigger>

      <PopoverContent
        align="end"
        side="bottom"
        className={`w-80 p-3 ${speechProviderStatus ? "hidden" : ""}`}
        sideOffset={8}
      >
        <div className="text-sm select-none">
          <div className="font-semibold text-orange-600 mb-1">
            Speech Provider Configuration Required
          </div>
          <p className="text-muted-foreground">
            {!speechProviderStatus ? (
              <>
                <div className="mt-2 flex flex-row gap-1 items-center text-orange-600">
                  <InfoIcon size={16} />
                  {selectedSttProvider.provider ? null : (
                    <p>PROVIDER IS MISSING</p>
                  )}
                </div>

                <span className="block mt-2">
                  Please go to settings and configure your speech provider to
                  enable voice input.
                </span>
              </>
            ) : null}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
};
