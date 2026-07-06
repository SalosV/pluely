import { Switch, Label, Header } from "@/components";
import { useApp } from "@/contexts";

interface ContentProtectionToggleProps {
  className?: string;
}

export const ContentProtectionToggle = ({
  className,
}: ContentProtectionToggleProps) => {
  const { customizable, toggleContentProtection } = useApp();

  const isEnabled = customizable?.contentProtection?.isEnabled ?? true;

  const handleSwitchChange = async (checked: boolean) => {
    await toggleContentProtection(checked);
  };

  return (
    <div id="content-protection" className={`space-y-2 ${className}`}>
      <Header
        title="Stealth Mode"
        description="Hide the window from screenshots, screen recordings, and screen sharing"
        isMainTitle
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div>
            <Label className="text-sm font-medium">
              {isEnabled ? "Disable Stealth Mode" : "Enable Stealth Mode"}
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              {isEnabled
                ? "Window is hidden from screenshots, recordings, and screen sharing (default)"
                : "Window is visible in screenshots, recordings, and screen sharing"}
            </p>
          </div>
        </div>
        <Switch
          checked={isEnabled}
          onCheckedChange={handleSwitchChange}
          title={`Toggle to ${!isEnabled ? "Enabled" : "Disabled"} stealth mode`}
          aria-label={`Toggle to ${
            isEnabled ? "Enabled" : "Disabled"
          } stealth mode`}
        />
      </div>
    </div>
  );
};
