import {
  Settings,
  KeyRoundIcon,
  MessagesSquare,
  WandSparkles,
  AudioLinesIcon,
  SquareSlashIcon,
  MonitorIcon,
  PowerIcon,
  CoffeeIcon,
  GlobeIcon,
  BugIcon,
  MessageSquareTextIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { XIcon, GithubIcon } from "@/components";

export const useMenuItems = () => {
  const menu: {
    icon: React.ElementType;
    label: string;
    href: string;
    count?: number;
  }[] = [
    {
      icon: MessagesSquare,
      label: "Chats",
      href: "/chats",
    },
    {
      // Formerly "Dev space" — this is the required AI/STT provider + API key
      // configuration, not a developer sandbox. Renamed and promoted so it's
      // discoverable as the first thing to set up.
      icon: KeyRoundIcon,
      label: "AI Providers",
      href: "/dev-space",
    },
    {
      icon: WandSparkles,
      label: "System prompts",
      href: "/system-prompts",
    },
    {
      icon: MessageSquareTextIcon,
      label: "Responses",
      href: "/responses",
    },
    {
      icon: MonitorIcon,
      label: "Screenshot",
      href: "/screenshot",
    },
    {
      icon: AudioLinesIcon,
      label: "Audio & Voice",
      href: "/audio",
    },
    {
      icon: SquareSlashIcon,
      label: "Cursor & Shortcuts",
      href: "/shortcuts",
    },
    {
      icon: Settings,
      label: "App Settings",
      href: "/settings",
    },
  ];

  const footerItems = [
    {
      icon: BugIcon,
      label: "Report a bug",
      href: "https://github.com/iamsrikanthnani/pluely/issues/new?template=bug-report.yml",
    },
    {
      icon: PowerIcon,
      label: "Quit pluely",
      action: async () => {
        await invoke("exit_app");
      },
    },
  ];

  const footerLinks: {
    title: string;
    icon: React.ElementType;
    link: string;
  }[] = [
    {
      title: "Website",
      icon: GlobeIcon,
      link: "https://pluely.com",
    },
    {
      title: "Github",
      icon: GithubIcon,
      link: "https://github.com/iamsrikanthnani/pluely",
    },
    {
      title: "Buy Me a Coffee",
      icon: CoffeeIcon,
      link: "https://buymeacoffee.com/srikanthnani",
    },
    {
      title: "Follow on X",
      icon: XIcon,
      link: "https://x.com/srikanthnani",
    },
  ];

  return {
    menu,
    footerItems,
    footerLinks,
  };
};
