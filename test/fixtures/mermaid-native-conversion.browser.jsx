/* global console, location */

import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import mermaid from "mermaid";

import {
  findDuplicateElementIds,
  installMermaidRenderIdPrefixShim,
  restoreMermaidLabelLineBreaks,
  sceneIsImageFallback,
} from "../../src/whiteboard-core.js";

// As the whiteboard frame does before its first conversion.
installMermaidRenderIdPrefixShim(mermaid);

// One source per diagram type the converter turns into editable shapes, plus a control
// it never parses. A mermaid release that changes the rendered DOM or the diagram.db
// internals the converter reads does not fail loudly: the converter logs the parser's
// exception to console.error and returns the rendered SVG as an image
// (mermaid-to-excalidraw#108). `labels` are strings the native scene must still carry,
// so a conversion that drops a subgraph, an entity, or an edge label is caught too.
const DIAGRAMS = {
  flowchart: {
    source: "flowchart TD\n  A[Start] --> B{Check}\n  B -->|yes| C[Done]\n  B -->|no| D[Retry]",
    labels: ["Start", "Check", "Done", "Retry", "yes", "no"],
  },
  subgraphFlowchart: {
    source: [
      "flowchart LR",
      "  subgraph ingest [Ingest]",
      "    a1[Read] --> a2[Parse]",
      "  end",
      "  subgraph serve [Serve]",
      "    b1[Index] --> b2[Query]",
      "  end",
      "  a2 --> b1",
    ].join("\n"),
    labels: ["Ingest", "Serve", "Read", "Parse", "Index", "Query"],
  },
  sequence: {
    source: "sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: Hello\n  B-->>A: Welcome",
    labels: ["Alice", "Bob", "Hello", "Welcome"],
  },
  class: {
    source: "classDiagram\n  class Animal {\n    +String name\n    +eat()\n  }\n  class Dog\n  Animal <|-- Dog",
    labels: ["Animal", "Dog", "name", "eat()"],
  },
  er: {
    source: "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains",
    labels: ["CUSTOMER", "ORDER", "LINE_ITEM", "places", "contains"],
  },
  state: {
    source: [
      "stateDiagram-v2",
      "  [*] --> Idle",
      "  Idle --> Running : start",
      "  Running --> Idle : stop",
      "  state Running {",
      "    [*] --> Busy",
      "    Busy --> [*]",
      "  }",
    ].join("\n"),
    labels: ["Idle", "Running", "Busy", "start", "stop"],
  },
};

const CONTROL = { source: 'pie title Pets\n  "Dogs" : 3\n  "Cats" : 2' };

// The same conversion the whiteboard frame runs (`convertSource` in
// src/whiteboard-frame.js), minus the font-load re-materialization, which does not
// depend on the mermaid version.
async function convert(source) {
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => {
    errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
  try {
    const { elements: parsed } = await parseMermaidToExcalidraw(source, { themeVariables: { fontSize: "16px" } });
    const skeletons = restoreMermaidLabelLineBreaks(parsed);
    let elements = convertToExcalidrawElements(skeletons, { regenerateIds: false });
    if (findDuplicateElementIds(elements).length > 0) {
      elements = convertToExcalidrawElements(skeletons, { regenerateIds: true });
    }
    return { elements, errors };
  } finally {
    console.error = consoleError;
  }
}

function sceneStrings(elements) {
  const strings = [];
  for (const element of elements) {
    for (const value of [element.text, element.originalText, element.name]) {
      if (typeof value === "string" && value) strings.push(value);
    }
  }
  return strings;
}

async function run() {
  const diagrams = {};
  for (const [name, { source, labels }] of Object.entries(DIAGRAMS)) {
    const { elements, errors } = await convert(source);
    const strings = sceneStrings(elements);
    diagrams[name] = {
      imageFallback: sceneIsImageFallback(elements),
      elements: elements.length,
      missingLabels: labels.filter((label) => !strings.some((value) => value.includes(label))),
      errors,
    };
  }
  const control = await convert(CONTROL.source);
  return {
    pass: true,
    diagrams,
    control: { imageFallback: sceneIsImageFallback(control.elements), elements: control.elements.length },
  };
}

function report(result) {
  location.replace(`/result?value=${encodeURIComponent(JSON.stringify(result))}`);
}

run().then(
  (result) => report(result),
  (error) => report({ pass: false, error: error?.stack || String(error) }),
);
