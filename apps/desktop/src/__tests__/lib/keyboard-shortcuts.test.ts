import { afterEach, describe, expect, it } from "vitest";
import {
  isEditableTarget,
  isTextEditingContext,
} from "@/hooks/use-keyboard-shortcuts";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("isEditableTarget", () => {
  it("treats inputs, textareas and contenteditable as editable", () => {
    document.body.innerHTML = `
      <input id="i" /><textarea id="t"></textarea>
      <div contenteditable="true"><span id="ce">x</span></div>`;
    expect(isEditableTarget(document.getElementById("i"))).toBe(true);
    expect(isEditableTarget(document.getElementById("t"))).toBe(true);
    expect(isEditableTarget(document.getElementById("ce"))).toBe(true);
  });

  it("treats anything inside a CodeMirror editor as editable", () => {
    document.body.innerHTML = `<div class="cm-editor"><div id="line">x</div></div>`;
    expect(isEditableTarget(document.getElementById("line"))).toBe(true);
  });

  it("does not treat plain elements or non-elements as editable", () => {
    document.body.innerHTML = `<div id="pdf"><canvas id="c"></canvas></div>`;
    expect(isEditableTarget(document.getElementById("c"))).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("isTextEditingContext (Cmd/Ctrl+X: cut vs. Capture & Ask, #133)", () => {
  it("keeps native cut inside editable elements", () => {
    document.body.innerHTML = `<textarea id="t">hello</textarea>`;
    expect(isTextEditingContext(document.getElementById("t"))).toBe(true);
  });

  it("keeps native cut/copy when text is selected elsewhere", () => {
    document.body.innerHTML = `<p id="p">some selectable text</p>`;
    const p = document.getElementById("p")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.addRange(range);
    expect(isTextEditingContext(p)).toBe(true);
  });

  it("allows Capture & Ask when nothing editable is focused or selected", () => {
    document.body.innerHTML = `<div id="pdf"></div>`;
    expect(isTextEditingContext(document.getElementById("pdf"))).toBe(false);
  });
});
