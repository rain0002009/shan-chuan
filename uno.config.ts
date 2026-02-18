import { defineConfig, presetAttributify, presetUno } from "unocss";

export default defineConfig({
  presets: [presetUno(), presetAttributify()],
  shortcuts: {
    btn: "border-0 rounded-[12px] px-3 py-2 text-white font-semibold cursor-pointer transition-all duration-100 ease-out active:translate-y-0 hover:-translate-y-[1px]",
    "btn-primary": "bg-gradient-to-r from-[#0f7bff] to-[#25d0ff]",
    "btn-secondary": "bg-gradient-to-r from-[#ff3f97] to-[#ff8a48]",
    "btn-mute": "bg-[#4f5f7b]",
    "btn-disabled": "opacity-52 cursor-not-allowed transform-none filter-none"
  }
});
