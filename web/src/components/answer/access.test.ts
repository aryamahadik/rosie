// T-514's accessibility proofs (01-inventory C-185 and RULES 4.11: WCAG 2.1 AA, no CAPTCHA): every control has a label,
// errors are announced, and the form works by keyboard alone; with no CAPTCHA. Each is checked on whole pages as the
// shell serves them: the question's page with options, with every kind of field and with a page step's fields; the
// form again with each problem; the read-back with and without a typed name; and every page the kit says why nothing
// was sent or saved on.
//
// "By keyboard alone" is held the way a page with no script can hold it: every control is a native one a browser puts
// in the tab order (a radio button, a text box, a button, a link), each set of radio buttons shares one name (the arrow
// keys move inside it), every form has its own submit button, and nothing needs a pointer or a script: no script, no
// event handler attribute, no tabindex but the frame's own on the main landmark, no access key, no autofocus.
//
// Every value is a fixture's own placeholder or made up (rule 9).
import { describe, expect, it } from "vitest";
import type { OutcomeOf } from "../../client/calls";
import {
  EVERY_KIND_QUESTION,
  LINK,
  S2_22_QUESTION,
  answerShell,
  formPost,
  getWith,
  post,
  s206Question,
  sessionCookie,
  tagsOf,
  textOfId,
  titleOf,
  visibleText,
  type AnswerShell,
  type Stubs,
} from "./test-support";
import type { AnswerReadBack } from "./kit";
import type { PageQuestion } from "./question-form";

const COOKIE_TOKEN = "dummy-session-token-0001";

/** A whole page as the shell answered it. */
interface Served {
  readonly status: number;
  readonly html: string;
}

async function served(response: Response): Promise<Served> {
  return { status: response.status, html: await response.text() };
}

/** The shell with `question` on its page and `stubs` for its calls. */
function shellFor(question: PageQuestion, stubs: Stubs = {}): AnswerShell {
  return answerShell({ question, stubs });
}

const answerPath = (shell: AnswerShell): string => `${shell.config.basePath}/${LINK}/answer`;
const yesPath = (shell: AnswerShell): string => `${shell.config.basePath}/${LINK}/answer/yes`;
const cookieOf = (shell: AnswerShell): Record<string, string> => sessionCookie(shell.config, COOKIE_TOKEN);

async function questionPage(shell: AnswerShell): Promise<Served> {
  return served(await shell.shell.fetch(getWith(answerPath(shell), cookieOf(shell))));
}

async function answered(shell: AnswerShell, values: Record<string, string>): Promise<Served> {
  const form = await questionPage(shell);
  return served(
    await shell.shell.fetch(post(answerPath(shell), formPost(form.html, values), cookieOf(shell))),
  );
}

/** A made-up read-back in K-21 v1's shape. */
function readBack(signature: "none" | "typedName"): AnswerReadBack {
  return {
    result: "readBack",
    readBackId: "rb-dummy-0001",
    stepId: "S2-22",
    questionId: "oq-s2-22-sam",
    words: "Made-up read-back words.",
    shown: [],
    signature,
    expiresAt: "2026-10-21T13:11:00Z",
  };
}

/** The read-back page, then the page the yes gets when the stub answers `outcome`. */
async function yesAnswer(
  outcome: OutcomeOf<"confirmOnPage">,
  signature: "none" | "typedName",
): Promise<Served> {
  const shell = shellFor(S2_22_QUESTION, {
    answerOnPage: () => readBack(signature),
    confirmOnPage: () => outcome,
  });
  const page = await answered(shell, { choice: "c-01" });
  return served(
    await shell.shell.fetch(
      post(yesPath(shell), formPost(page.html, { decision: "yes", typedName: "Sam Lee" }), cookieOf(shell)),
    ),
  );
}

/** Each page the kit serves, by a name for the test's title. */
async function everyPage(): Promise<[string, Served][]> {
  const pages: [string, Served][] = [];
  pages.push(["S2-22's question", await questionPage(shellFor(S2_22_QUESTION))]);
  pages.push(["every kind of field", await questionPage(shellFor(EVERY_KIND_QUESTION))]);
  pages.push(["S2-06's page step", await questionPage(shellFor(s206Question()))]);
  pages.push(["no option picked", await answered(shellFor(S2_22_QUESTION), {})]);
  pages.push([
    "fieldsInvalid on every kind",
    await answered(
      shellFor(EVERY_KIND_QUESTION, {
        answerOnPage: () => ({
          error: "fieldsInvalid",
          fields: ["name", "visits", "kept", "price", "time_saved", "zone", "place.id", "which", "gone"],
        }),
      }),
      { choice: "c-01", "field.visits": "two" },
    ),
  ]);
  pages.push([
    "safety first",
    await answered(
      shellFor(S2_22_QUESTION, {
        answerOnPage: () => ({
          error: "safetyFirst",
          outcomeId: "safety-dummy-0001",
          fixedLineId: "line-dummy-0001",
          words: "Made-up safety line.",
        }),
      }),
      { choice: "c-01" },
    ),
  ]);
  pages.push([
    "sign in",
    await served(
      await (async () => {
        const shell = shellFor(S2_22_QUESTION);
        const form = await questionPage(shell);
        return shell.shell.fetch(post(answerPath(shell), formPost(form.html, { choice: "c-01" })));
      })(),
    ),
  ]);
  pages.push([
    "read-back, yes alone",
    await answered(shellFor(S2_22_QUESTION, { answerOnPage: () => readBack("none") }), { choice: "c-01" }),
  ]);
  pages.push([
    "read-back, typed name",
    await answered(shellFor(S2_22_QUESTION, { answerOnPage: () => readBack("typedName") }), {
      choice: "c-01",
    }),
  ]);
  pages.push([
    "read-back changed",
    await yesAnswer(
      { error: "readBackChanged", readBack: { ...readBack("typedName"), readBackId: "rb-dummy-0002" } },
      "none",
    ),
  ]);
  pages.push(["saved", await yesAnswer(committed(), "none")]);
  pages.push(["read-back expired", await yesAnswer({ error: "readBackExpired" }, "none")]);
  pages.push(["signature needed", await yesAnswer({ error: "signatureNeeded" }, "none")]);
  return pages;
}

/** A made-up committed answer in K-21 v1's shape. */
function committed(): OutcomeOf<"confirmOnPage"> {
  return {
    result: "committed",
    readBackId: "rb-dummy-0001",
    yesEventId: "pageyes-dummy-0001",
    served: {
      call: "saveSetupStep",
      response: {
        step: "S2-22",
        gives: [],
        branch: null,
        written: [],
        openQuestionId: null,
        outboxRowIds: [],
        clockRowIds: [],
        effects: [],
        reviewItemId: null,
        repeated: false,
      },
    },
  };
}

/** The main landmark's content: what the kit put in the frame. */
function mainOf(html: string): string {
  return /<main id="main" tabindex="-1">([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
}

/** Every id in `html`. */
function idsOf(html: string): string[] {
  return [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1] ?? "");
}

/** The controls a person uses: every input but the hidden ones, every select, every text area. */
function controlsOf(html: string) {
  return [
    ...tagsOf(html, "input").filter((tag) => tag.attributes.type !== "hidden"),
    ...tagsOf(html, "select"),
    ...tagsOf(html, "textarea"),
  ];
}

describe("every control has a label", () => {
  it("each control has an id and exactly one label for it, with words, and every label names a control", async () => {
    for (const [name, page] of await everyPage()) {
      const main = mainOf(page.html);
      const controls = controlsOf(main);
      const ids = new Set(controls.map((tag) => tag.attributes.id ?? ""));
      for (const control of controls) {
        const id = control.attributes.id ?? "";
        expect(id, name).not.toBe("");
        const labels = [
          ...main.matchAll(new RegExp(`<label for="${id.replaceAll(".", "\\.")}">([^<]*)</label>`, "g")),
        ];
        expect(labels, `${name}: ${id}`).toHaveLength(1);
        expect(labels[0]?.[1]?.trim(), `${name}: ${id}`).not.toBe("");
      }
      for (const label of tagsOf(main, "label")) expect(ids.has(label.attributes.for ?? ""), name).toBe(true);
    }
  });

  it("every radio button sits in a fieldset whose legend says what the set is: the question's words, or the field's label", async () => {
    for (const [name, page] of await everyPage()) {
      const main = mainOf(page.html);
      for (const fieldset of main.split("<fieldset").slice(1)) {
        const inner = fieldset.slice(0, fieldset.indexOf("</fieldset>"));
        expect(/^[^>]*>\n<legend>[^<]+<\/legend>/.test(inner), name).toBe(true);
      }
      const outside = main.replace(/<fieldset[\s\S]*?<\/fieldset>/g, "");
      expect(
        tagsOf(outside, "input").filter((tag) => tag.attributes.type === "radio"),
        name,
      ).toEqual([]);
    }
  });

  it("the question's words are the options' legend, and each option's label is its own words as the server gave them", async () => {
    const page = await questionPage(shellFor(EVERY_KIND_QUESTION));
    expect(page.html).toContain(`<legend>${EVERY_KIND_QUESTION.words}</legend>`);
    for (const option of EVERY_KIND_QUESTION.options) expect(page.html).toContain(`>${option.label}</label>`);
  });

  it("each field's label is its name in words, or the words a page knows for it; the person's own name and email carry their purpose (WCAG 1.3.5)", async () => {
    const page = await questionPage(shellFor(EVERY_KIND_QUESTION));
    const text = visibleText(mainOf(page.html));
    for (const label of ["Your name", "Visits", "Kept", "Price", "Time saved", "Zone", "Place id", "Which"])
      expect(text).toContain(label);
    const name = tagsOf(page.html, "input").find((tag) => tag.attributes.name === "field.name");
    expect(name?.attributes.autocomplete).toBe("name");
    const s206 = await questionPage(shellFor(s206Question()));
    expect(visibleText(mainOf(s206.html))).toContain("Languages you speak");
  });

  it("a field's kind gives its hint, tied to its box by aria-describedby, and a number or an amount opens the number keys", async () => {
    const page = await questionPage(shellFor(EVERY_KIND_QUESTION));
    const box = (field: string) =>
      tagsOf(page.html, "input").find((tag) => tag.attributes.name === `field.${field}`);
    expect(textOfId(page.html, box("visits")?.attributes["aria-describedby"] ?? "")).toBe(
      "A whole number, like 2.",
    );
    expect(box("visits")?.attributes.inputmode).toBe("numeric");
    expect(box("price")?.attributes.inputmode).toBe("decimal");
    expect(box("price")?.attributes.value).toBe("45");
    expect(textOfId(page.html, box("time_saved")?.attributes["aria-describedby"] ?? "")).toBe(
      "A day and a time, like Tuesday 3pm.",
    );
    // A yes-or-no field and a field that names one of the options are sets of radio buttons of their own.
    expect(
      tagsOf(page.html, "input")
        .filter((tag) => tag.attributes.name === "field.kept")
        .map((tag) => tag.attributes.value),
    ).toEqual(["yes", "no"]);
    expect(
      tagsOf(page.html, "input")
        .filter((tag) => tag.attributes.name === "field.which")
        .map((tag) => tag.attributes.value),
    ).toEqual(["c-01", "c-02"]);
  });

  it("every button and every link says what it does in words", async () => {
    for (const [name, page] of await everyPage()) {
      const main = mainOf(page.html);
      for (const match of main.matchAll(/<button[^>]*>([^<]*)<\/button>/g))
        expect(match[1]?.trim(), name).not.toBe("");
      expect(main.match(/<button/g)?.length ?? 0, name).toBe(
        [...main.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].length,
      );
      for (const match of main.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g))
        expect(match[2]?.trim(), name).not.toBe("");
      expect(main.match(/<a /g)?.length ?? 0, name).toBe(
        [...main.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)].length,
      );
    }
  });
});

describe("errors are announced", () => {
  it("a form with a problem says it first in an alert with a heading, links each control it names, and its title starts 'Error:'", async () => {
    const page = await answered(shellFor(S2_22_QUESTION), {});
    expect(page.status).toBe(400);
    expect(titleOf(page.html)).toBe("Error: Your team");
    const main = mainOf(page.html);
    const alert = /<div role="alert" aria-labelledby="([^"]+)">([\s\S]*?)<\/div>/.exec(main);
    expect(alert).not.toBeNull();
    expect(textOfId(main, alert?.[1] ?? "")).toBe("There is a problem");
    // The alert comes before the form.
    expect(main.indexOf('role="alert"')).toBeLessThan(main.indexOf("<form"));
    const links = tagsOf(alert?.[2] ?? "", "a").map((tag) => tag.attributes.href ?? "");
    expect(links).toEqual(["#answer-choice-0"]);
    expect(idsOf(main)).toContain("answer-choice-0");
  });

  it("the set of radio buttons with a problem is described by its message, which starts 'Error:'", async () => {
    const page = await answered(shellFor(S2_22_QUESTION), {});
    const fieldset = tagsOf(page.html, "fieldset")[0];
    const describedBy = fieldset?.attributes["aria-describedby"] ?? "";
    expect(textOfId(page.html, describedBy)).toBe("Error: Pick one of the options.");
  });

  it("fieldsInvalid: each field named is marked invalid and described by its own message, the summary links it, and a field the question lacks is listed without a link", async () => {
    const [, page] = (await everyPage()).find(([name]) => name === "fieldsInvalid on every kind") ?? [];
    if (page === undefined) throw new Error("no fieldsInvalid page");
    expect(page.status).toBe(400);
    expect(titleOf(page.html)).toMatch(/^Error: /);
    const main = mainOf(page.html);
    for (const field of ["name", "visits", "price", "time_saved", "zone", "place.id"]) {
      const box = tagsOf(main, "input").find((tag) => tag.attributes.name === `field.${field}`);
      expect(box?.attributes["aria-invalid"], field).toBe("true");
      const messages = (box?.attributes["aria-describedby"] ?? "")
        .split(" ")
        .map((id) => textOfId(main, id) ?? "");
      expect(
        messages.some((message) => message.startsWith("Error: ")),
        field,
      ).toBe(true);
      expect(main, field).toContain(`<a href="#${box?.attributes.id ?? ""}">`);
    }
    for (const field of ["kept", "which"]) {
      const group = tagsOf(main, "fieldset").find((tag) =>
        (tag.attributes["aria-describedby"] ?? "").includes(field),
      );
      expect(textOfId(main, group?.attributes["aria-describedby"] ?? ""), field).toMatch(/^Error: Pick/);
    }
    expect(textOfId(main, "answer-field-visits-error")).toBe("Error: Type a whole number, like 2.");
    expect(visibleText(main)).toContain("Gone: Rosie could not read this. Type it again.");
    // A field's typed words are never shown back.
    expect(main).not.toContain('value="two"');
  });

  it("every aria-describedby names an element on the page, and no id is used twice", async () => {
    for (const [name, page] of await everyPage()) {
      const ids = idsOf(page.html);
      expect(new Set(ids).size, name).toBe(ids.length);
      for (const tag of [...tagsOf(page.html, "input"), ...tagsOf(page.html, "fieldset")]) {
        for (const id of (tag.attributes["aria-describedby"] ?? "").split(" ").filter((one) => one !== ""))
          expect(ids, `${name}: ${id}`).toContain(id);
      }
    }
  });

  it("a page that says why nothing was sent or saved announces it in an alert, and its title starts 'Error:'", async () => {
    for (const [name, page] of await everyPage()) {
      if (
        !["safety first", "sign in", "read-back changed", "read-back expired", "signature needed"].includes(
          name,
        )
      )
        continue;
      expect(titleOf(page.html), name).toMatch(/^Error: /);
      expect(mainOf(page.html), name).toContain('<p role="alert">');
    }
  });

  it("the safety line is the first thing said after the heading, in the alert, as the server gave it", async () => {
    const [, page] = (await everyPage()).find(([name]) => name === "safety first") ?? [];
    expect(mainOf(page?.html ?? "")).toMatch(
      /^\n<h1>Please read this first<\/h1>\n<p role="alert">Made-up safety line\.<\/p>/,
    );
  });
});

describe("the form works by keyboard alone", () => {
  it("every control is a native one: radio buttons, text boxes, buttons and links, with nothing that needs a pointer or a script", async () => {
    for (const [name, page] of await everyPage()) {
      const { html } = page;
      expect(html, name).not.toMatch(/<script/i);
      expect(html, name).not.toMatch(/\son[a-z]+=/i);
      expect(html, name).not.toMatch(/\saccesskey=/i);
      expect(html, name).not.toMatch(/\sautofocus/i);
      expect(html, name).not.toMatch(/\scontenteditable/i);
      expect(html, name).not.toMatch(/\sdraggable/i);
      expect(html, name).not.toMatch(/\srole="(?:button|link|checkbox|radio|textbox)"/);
      // The frame's own tabindex on the main landmark (its skip link's target) is the only one.
      expect(
        [...html.matchAll(/\stabindex="([^"]*)"/g)].map((match) => match[1]),
        name,
      ).toEqual(["-1"]);
      for (const control of controlsOf(html))
        expect(["radio", "text"], name).toContain(control.attributes.type);
    }
  });

  it("every form posts to this site with its own submit button, and each set of radio buttons shares one name", async () => {
    for (const [name, page] of await everyPage()) {
      const main = mainOf(page.html);
      for (const form of main.split("<form").slice(1)) {
        const inner = form.slice(0, form.indexOf("</form>"));
        expect(inner, name).toMatch(/^ method="post" action="\/test\//);
        expect(inner, name).toContain('<button type="submit"');
        for (const fieldset of inner.split("<fieldset").slice(1)) {
          const radios = tagsOf(fieldset.slice(0, fieldset.indexOf("</fieldset>")), "input").filter(
            (tag) => tag.attributes.type === "radio",
          );
          expect(new Set(radios.map((tag) => tag.attributes.name)).size, name).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("the read-back's yes and its typed name are reached in order: the name box, then the yes, then the way back", async () => {
    const [, page] = (await everyPage()).find(([name]) => name === "read-back, typed name") ?? [];
    const main = mainOf(page?.html ?? "");
    const box = main.indexOf('name="typedName"');
    const yes = main.indexOf('value="yes"');
    const back = main.indexOf("No, go back without saving");
    expect(box).toBeGreaterThan(0);
    expect(box).toBeLessThan(yes);
    expect(yes).toBeLessThan(back);
  });
});

describe("no CAPTCHA", () => {
  it("no page holds a CAPTCHA, a challenge, an image to read, a frame or anything loaded from outside", async () => {
    for (const [name, page] of await everyPage()) {
      const { html } = page;
      expect(html, name).not.toMatch(/captcha|turnstile|challenge/i);
      expect(html, name).not.toMatch(/<(?:iframe|img|canvas|object|embed|audio|video|svg)\b/i);
      expect(html, name).not.toMatch(/\ssrc=/i);
      expect(html, name).not.toMatch(/https?:\/\//);
    }
  });
});
