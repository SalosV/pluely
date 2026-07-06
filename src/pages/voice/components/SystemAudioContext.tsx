import { useState } from "react";
import {
  Header,
  Label,
  Switch,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectLabel,
  SelectGroup,
} from "@/components";
import { WandIcon } from "lucide-react";
import { useSystemAudioContextStore } from "@/hooks";
import {
  PROMPT_TEMPLATES,
  getPromptTemplateById,
} from "@/lib/platform-instructions";

export const SystemAudioContext = () => {
  const {
    useSystemPrompt,
    contextContent,
    setUseSystemPrompt,
    setContextContent,
  } = useSystemAudioContextStore();
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");

  const handleTemplateSelection = (templateId: string) => {
    const template = getPromptTemplateById(templateId);
    if (template) {
      setContextContent(template.prompt);
      setSelectedTemplate("");
    }
  };

  return (
    <div className="space-y-4">
      <Header
        isMainTitle
        title="System Audio Context"
        description="Choose which prompt guides AI responses to captured system audio."
      />

      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <Label className="text-sm font-medium">Use System Prompt</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {useSystemPrompt
              ? "Using default prompt from settings"
              : "Using custom context below"}
          </p>
        </div>
        <Switch
          checked={useSystemPrompt}
          onCheckedChange={setUseSystemPrompt}
        />
      </div>

      {/* Custom Context */}
      {!useSystemPrompt && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <Select
              value={selectedTemplate}
              onValueChange={handleTemplateSelection}
            >
              <SelectTrigger className="w-auto h-7 text-xs">
                <WandIcon className="w-3 h-3 mr-1.5" />
                <SelectValue placeholder="Templates" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-xs py-1">
                    Quick-fill a template
                  </SelectLabel>
                  {PROMPT_TEMPLATES.map((template) => (
                    <SelectItem
                      key={template.id}
                      value={template.id}
                      className="text-xs"
                    >
                      {template.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            placeholder="Enter custom system prompt and context..."
            value={contextContent}
            onChange={(e) => setContextContent(e.target.value)}
            className="min-h-24 resize-none text-xs"
          />
        </div>
      )}
    </div>
  );
};
