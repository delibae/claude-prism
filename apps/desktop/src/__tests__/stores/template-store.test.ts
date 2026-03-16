import { describe, it, expect, beforeEach } from "vitest";
import { useTemplateStore } from "@/stores/template-store";
import { getAllTemplates } from "@/lib/template-registry";

describe("useTemplateStore", () => {
  beforeEach(() => {
    useTemplateStore.getState().reset();
  });

  it("initializes with all templates", () => {
    const all = getAllTemplates();
    const { filteredTemplates } = useTemplateStore.getState();
    expect(filteredTemplates).toHaveLength(all.length);
  });

  describe("setSearchQuery", () => {
    it("filters templates by keyword", () => {
      useTemplateStore.getState().setSearchQuery("paper");
      const { filteredTemplates } = useTemplateStore.getState();
      expect(filteredTemplates.length).toBeGreaterThan(0);
      expect(filteredTemplates.length).toBeLessThan(getAllTemplates().length);
    });

    it("returns all templates for empty query", () => {
      useTemplateStore.getState().setSearchQuery("paper");
      useTemplateStore.getState().setSearchQuery("");
      expect(useTemplateStore.getState().filteredTemplates).toHaveLength(
        getAllTemplates().length,
      );
    });
  });

  describe("setSelectedCategory", () => {
    it("filters by category", () => {
      useTemplateStore.getState().setSelectedCategory("academic");
      const { filteredTemplates } = useTemplateStore.getState();
      expect(filteredTemplates.length).toBeGreaterThan(0);
      expect(filteredTemplates.every((t) => t.category === "academic")).toBe(
        true,
      );
    });

    it("clears category filter with null", () => {
      useTemplateStore.getState().setSelectedCategory("academic");
      useTemplateStore.getState().setSelectedCategory(null);
      expect(useTemplateStore.getState().filteredTemplates).toHaveLength(
        getAllTemplates().length,
      );
    });
  });

  describe("combined filters", () => {
    it("applies search + category together", () => {
      useTemplateStore.getState().setSearchQuery("paper");
      useTemplateStore.getState().setSelectedCategory("academic");
      const { filteredTemplates } = useTemplateStore.getState();
      expect(filteredTemplates.length).toBeGreaterThan(0);
      expect(filteredTemplates.every((t) => t.category === "academic")).toBe(
        true,
      );
    });
  });
});
