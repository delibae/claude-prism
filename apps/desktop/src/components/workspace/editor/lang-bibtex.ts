/**
 * BibTeX language support for CodeMirror 6.
 *
 * Provides syntax highlighting for .bib files with support for:
 * - Entry types (@article, @book, @inproceedings, etc.)
 * - Citation keys
 * - Field names (author, title, year, etc.)
 * - String values (both braced and quoted)
 * - Comments (@comment and %-prefixed)
 * - @string and @preamble directives
 */
import {
  StreamLanguage,
  type StringStream,
  type StreamParser,
  LanguageSupport,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

interface BibState {
  /** Current parsing context */
  context:
    | "top"
    | "entryType"
    | "citationKey"
    | "fields"
    | "fieldName"
    | "fieldSep"
    | "fieldValue"
    | "comment";
  /** Brace nesting depth inside a field value */
  braceDepth: number;
  /** Whether currently inside a quoted string value */
  inQuote: boolean;
}

const bibtexParser: StreamParser<BibState> = {
  name: "bibtex",

  startState(): BibState {
    return { context: "top", braceDepth: 0, inQuote: false };
  },

  token(stream: StringStream, state: BibState): string | null {
    // ── Top-level ──
    if (state.context === "top") {
      if (stream.eatSpace()) return null;

      // %-style comment
      if (stream.peek() === "%") {
        stream.skipToEnd();
        return "lineComment";
      }

      // Entry start: @type
      if (stream.eat("@")) {
        state.context = "entryType";
        return "keyword";
      }

      // Anything else at top level is implicitly a comment
      stream.skipToEnd();
      return "lineComment";
    }

    // ── Entry type (article, book, string, comment, preamble, ...) ──
    if (state.context === "entryType") {
      if (stream.eatSpace()) return null;

      const type = stream.match(/^[a-zA-Z]+/);
      if (type) {
        const typeName = (type as RegExpMatchArray)[0].toLowerCase();
        if (typeName === "comment") {
          state.context = "comment";
          return "keyword";
        }
        if (stream.peek() === "{" || stream.peek() === "(") {
          // Will move to citationKey or fields after opening brace
          state.context = "citationKey";
        } else {
          state.context = "top";
        }
        return "typeName";
      }

      // Opening brace after type (e.g., for @string{...})
      if (stream.eat("{") || stream.eat("(")) {
        state.context = "citationKey";
        return "brace";
      }

      stream.next();
      state.context = "top";
      return null;
    }

    // ── @comment block: skip everything until matching brace ──
    if (state.context === "comment") {
      if (stream.eat("{")) {
        state.braceDepth = 1;
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === "{") state.braceDepth++;
          else if (ch === "}") {
            state.braceDepth--;
            if (state.braceDepth === 0) {
              state.context = "top";
              return "lineComment";
            }
          }
        }
        return "lineComment";
      }
      stream.skipToEnd();
      state.context = "top";
      return "lineComment";
    }

    // ── Citation key (the part after @type{) ──
    if (state.context === "citationKey") {
      if (stream.eatSpace()) return null;

      // Opening brace
      if (stream.eat("{") || stream.eat("(")) {
        return "brace";
      }

      // The citation key itself
      if (stream.match(/^[^,\s{}()]+/)) {
        state.context = "fields";
        return "labelName";
      }

      // Comma after citation key
      if (stream.eat(",")) {
        state.context = "fieldName";
        return "separator";
      }

      // Closing brace (empty entry)
      if (stream.eat("}") || stream.eat(")")) {
        state.context = "top";
        return "brace";
      }

      stream.next();
      return null;
    }

    // ── Fields section (looking for field names or closing brace) ──
    if (state.context === "fields") {
      if (stream.eatSpace()) return null;

      if (stream.eat(",")) {
        state.context = "fieldName";
        return "separator";
      }

      if (stream.eat("}") || stream.eat(")")) {
        state.context = "top";
        return "brace";
      }

      // Sometimes the parser lands here directly, try field name
      state.context = "fieldName";
      return null;
    }

    // ── Field name ──
    if (state.context === "fieldName") {
      if (stream.eatSpace()) return null;

      // Closing brace (end of entry)
      if (stream.eat("}") || stream.eat(")")) {
        state.context = "top";
        return "brace";
      }

      // Comma between fields
      if (stream.eat(",")) {
        return "separator";
      }

      // Field name
      if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_-]*/)) {
        state.context = "fieldSep";
        return "propertyName";
      }

      stream.next();
      return null;
    }

    // ── Field separator (=) ──
    if (state.context === "fieldSep") {
      if (stream.eatSpace()) return null;

      if (stream.eat("=")) {
        state.context = "fieldValue";
        state.braceDepth = 0;
        state.inQuote = false;
        return "operator";
      }

      // If we see something unexpected, go back to field name context
      state.context = "fieldName";
      return null;
    }

    // ── Field value ──
    if (state.context === "fieldValue") {
      if (stream.eatSpace()) return null;

      // Concatenation operator
      if (stream.eat("#")) {
        return "operator";
      }

      // Braced value
      if (stream.peek() === "{" && !state.inQuote) {
        if (state.braceDepth === 0) {
          stream.next();
          state.braceDepth = 1;
          return "brace";
        }
      }

      if (state.braceDepth > 0) {
        // Inside braced value
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === "\\") {
            stream.next(); // skip escaped char
            continue;
          }
          if (ch === "{") {
            state.braceDepth++;
          } else if (ch === "}") {
            state.braceDepth--;
            if (state.braceDepth === 0) {
              state.context = "fields";
              return "string";
            }
          }
        }
        return "string";
      }

      // Quoted value
      if (stream.peek() === '"' && !state.inQuote && state.braceDepth === 0) {
        stream.next();
        state.inQuote = true;
        return "string";
      }

      if (state.inQuote) {
        let braces = 0;
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === "\\") {
            stream.next();
            continue;
          }
          if (ch === "{") braces++;
          else if (ch === "}") braces--;
          else if (ch === '"' && braces === 0) {
            state.inQuote = false;
            state.context = "fields";
            return "string";
          }
        }
        return "string";
      }

      // Numeric value
      if (stream.match(/^\d+/)) {
        state.context = "fields";
        return "number";
      }

      // String reference (macro name like jan, feb, etc.)
      if (stream.match(/^[a-zA-Z][a-zA-Z0-9_]*/)) {
        state.context = "fields";
        return "variableName";
      }

      // Comma → next field
      if (stream.eat(",")) {
        state.context = "fieldName";
        return "separator";
      }

      // Closing brace → end of entry
      if (stream.eat("}") || stream.eat(")")) {
        state.context = "top";
        return "brace";
      }

      stream.next();
      return null;
    }

    stream.next();
    return null;
  },

  tokenTable: {
    keyword: tags.keyword,
    typeName: tags.typeName,
    labelName: tags.labelName,
    propertyName: tags.propertyName,
    string: tags.string,
    number: tags.number,
    operator: tags.operator,
    brace: tags.brace,
    separator: tags.separator,
    lineComment: tags.lineComment,
    variableName: tags.variableName,
  },
};

const bibtexLanguage = StreamLanguage.define(bibtexParser);

export function bibtex(): LanguageSupport {
  return new LanguageSupport(bibtexLanguage);
}
