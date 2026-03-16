import { create } from "zustand";
import {
  type TemplateCategory,
  type TemplateDefinition,
  getAllTemplates,
  searchTemplates,
} from "@/lib/template-registry";

interface TemplateState {
  // Filters
  searchQuery: string;
  selectedCategory: TemplateCategory | null;

  // Selection
  selectedTemplateId: string | null;
  previewTemplateId: string | null;

  // Computed
  filteredTemplates: TemplateDefinition[];

  // Actions
  setSearchQuery: (query: string) => void;
  setSelectedCategory: (category: TemplateCategory | null) => void;
  selectTemplate: (id: string | null) => void;
  openPreview: (id: string) => void;
  closePreview: () => void;
  reset: () => void;
}

function computeFiltered(
  query: string,
  category: TemplateCategory | null,
): TemplateDefinition[] {
  let results = query ? searchTemplates(query) : getAllTemplates();
  if (category) {
    results = results.filter((t) => t.category === category);
  }
  return results;
}

export const useTemplateStore = create<TemplateState>((set) => ({
  searchQuery: "",
  selectedCategory: null,
  selectedTemplateId: null,
  previewTemplateId: null,
  filteredTemplates: getAllTemplates(),

  setSearchQuery: (query) =>
    set((s) => ({
      searchQuery: query,
      filteredTemplates: computeFiltered(query, s.selectedCategory),
    })),

  setSelectedCategory: (category) =>
    set((s) => ({
      selectedCategory: category,
      filteredTemplates: computeFiltered(s.searchQuery, category),
    })),

  selectTemplate: (id) => set({ selectedTemplateId: id }),

  openPreview: (id) => set({ previewTemplateId: id }),

  closePreview: () => set({ previewTemplateId: null }),

  reset: () =>
    set({
      searchQuery: "",
      selectedCategory: null,
      selectedTemplateId: null,
      previewTemplateId: null,
      filteredTemplates: getAllTemplates(),
    }),
}));
