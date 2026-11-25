// Generated from the engine by crates/core/tests/engine_constants.rs: do not edit.
// `UPDATE_ENGINE_CONSTANTS=1 cargo test -p filum-core --test engine_constants`
// writes it anew; the test fails while it is out of date.

/** Stitch flags of a plan record (crates/core/src/plan.rs, the formats crate's command bits). */
export const FLAG = {
  "COLOR_CHANGE": 4,
  "COMMANDS": 31,
  "END": 16,
  "JUMP": 1,
  "STOP": 8,
  "TIE": 32,
  "TRAVEL": 128,
  "TRIM": 2,
  "UNDERLAY": 64
} as const;

/** `plan.objects` of a record no object sews (a command, the frame moving out). */
export const NO_OBJECT = 4294967295;

/** What a jump costs the machine (s). */
export const JUMP_SECONDS = 0.05;

/**
 * Per fabric: whether it stretches or is delicate, automatic underlay's
 * widths (mm; fills: none below the first, an edge run below the second;
 * satins: none, centre walk, contour), whether Optimise sews it centre out,
 * and what it takes (the density model's limits).
 */
export const FABRICS = {
  "canvas": {
    "autoFill": [
      2.5,
      8.0
    ],
    "autoSatin": [
      1.2,
      2.5,
      4.0
    ],
    "centerOut": false,
    "delicate": false,
    "limits": {
      "gsm": 350.0,
      "holesHeavy": 14.0,
      "holesMax": 25.0,
      "layersHeavy": 2.8,
      "layersMax": 4.4,
      "layersMin": 0.6,
      "stiffRatio": 0.8
    },
    "stretch": false
  },
  "cap": {
    "autoFill": [
      2.5,
      8.0
    ],
    "autoSatin": [
      1.2,
      2.5,
      4.0
    ],
    "centerOut": true,
    "delicate": false,
    "limits": {
      "gsm": 300.0,
      "holesHeavy": 14.0,
      "holesMax": 25.0,
      "layersHeavy": 3.0,
      "layersMax": 4.8,
      "layersMin": 0.6,
      "stiffRatio": 1.0
    },
    "stretch": false
  },
  "cotton": {
    "autoFill": [
      2.5,
      8.0
    ],
    "autoSatin": [
      1.2,
      2.5,
      4.0
    ],
    "centerOut": false,
    "delicate": false,
    "limits": {
      "gsm": 130.0,
      "holesHeavy": 10.0,
      "holesMax": 17.0,
      "layersHeavy": 2.4,
      "layersMax": 3.8,
      "layersMin": 0.6,
      "stiffRatio": 1.5
    },
    "stretch": false
  },
  "denim": {
    "autoFill": [
      2.5,
      8.0
    ],
    "autoSatin": [
      1.2,
      2.5,
      4.0
    ],
    "centerOut": false,
    "delicate": false,
    "limits": {
      "gsm": 400.0,
      "holesHeavy": 14.0,
      "holesMax": 25.0,
      "layersHeavy": 2.8,
      "layersMax": 4.4,
      "layersMin": 0.6,
      "stiffRatio": 0.8
    },
    "stretch": false
  },
  "felt": {
    "autoFill": [
      2.5,
      8.0
    ],
    "autoSatin": [
      1.2,
      2.5,
      4.0
    ],
    "centerOut": false,
    "delicate": false,
    "limits": {
      "gsm": 300.0,
      "holesHeavy": 12.0,
      "holesMax": 22.0,
      "layersHeavy": 2.8,
      "layersMax": 4.4,
      "layersMin": 0.5,
      "stiffRatio": 1.0
    },
    "stretch": false
  },
  "fleece": {
    "autoFill": [
      2.0,
      6.0
    ],
    "autoSatin": [
      1.0,
      2.0,
      3.0
    ],
    "centerOut": true,
    "delicate": false,
    "limits": {
      "gsm": 250.0,
      "holesHeavy": 10.0,
      "holesMax": 18.0,
      "layersHeavy": 2.6,
      "layersMax": 4.0,
      "layersMin": 0.7,
      "stiffRatio": 1.0
    },
    "stretch": true
  },
  "knit": {
    "autoFill": [
      2.0,
      6.0
    ],
    "autoSatin": [
      1.0,
      2.0,
      3.0
    ],
    "centerOut": true,
    "delicate": false,
    "limits": {
      "gsm": 160.0,
      "holesHeavy": 8.0,
      "holesMax": 14.0,
      "layersHeavy": 2.1,
      "layersMax": 3.2,
      "layersMin": 0.6,
      "stiffRatio": 1.2
    },
    "stretch": true
  },
  "leather": {
    "autoFill": [
      3.0,
      12.0
    ],
    "autoSatin": [
      1.5,
      3.0,
      5.0
    ],
    "centerOut": false,
    "delicate": true,
    "limits": {
      "gsm": 600.0,
      "holesHeavy": 5.0,
      "holesMax": 9.0,
      "layersHeavy": 1.8,
      "layersMax": 2.8,
      "layersMin": 0.5,
      "stiffRatio": 0.5
    },
    "stretch": false
  },
  "pique": {
    "autoFill": [
      2.0,
      6.0
    ],
    "autoSatin": [
      1.0,
      2.0,
      3.0
    ],
    "centerOut": true,
    "delicate": false,
    "limits": {
      "gsm": 200.0,
      "holesHeavy": 9.0,
      "holesMax": 16.0,
      "layersHeavy": 2.4,
      "layersMax": 3.8,
      "layersMin": 0.65,
      "stiffRatio": 1.0
    },
    "stretch": true
  },
  "polyester": {
    "autoFill": [
      2.5,
      8.0
    ],
    "autoSatin": [
      1.2,
      2.5,
      4.0
    ],
    "centerOut": false,
    "delicate": false,
    "limits": {
      "gsm": 110.0,
      "holesHeavy": 10.0,
      "holesMax": 17.0,
      "layersHeavy": 2.4,
      "layersMax": 3.8,
      "layersMin": 0.6,
      "stiffRatio": 1.5
    },
    "stretch": false
  },
  "sheer": {
    "autoFill": [
      2.0,
      6.0
    ],
    "autoSatin": [
      1.0,
      2.0,
      3.0
    ],
    "centerOut": false,
    "delicate": false,
    "limits": {
      "gsm": 40.0,
      "holesHeavy": 5.0,
      "holesMax": 9.0,
      "layersHeavy": 1.6,
      "layersMax": 2.4,
      "layersMin": 0.5,
      "stiffRatio": 3.0
    },
    "stretch": true
  },
  "silk": {
    "autoFill": [
      3.0,
      12.0
    ],
    "autoSatin": [
      1.5,
      3.0,
      5.0
    ],
    "centerOut": false,
    "delicate": true,
    "limits": {
      "gsm": 70.0,
      "holesHeavy": 6.0,
      "holesMax": 11.0,
      "layersHeavy": 1.7,
      "layersMax": 2.6,
      "layersMin": 0.6,
      "stiffRatio": 2.0
    },
    "stretch": false
  },
  "towel": {
    "autoFill": [
      2.0,
      6.0
    ],
    "autoSatin": [
      1.0,
      2.0,
      3.0
    ],
    "centerOut": true,
    "delicate": false,
    "limits": {
      "gsm": 450.0,
      "holesHeavy": 12.0,
      "holesMax": 22.0,
      "layersHeavy": 2.8,
      "layersMax": 4.4,
      "layersMin": 0.8,
      "stiffRatio": 0.7
    },
    "stretch": true
  }
} as const;

/** Linear density (tex) of the thread weights. */
export const THREAD_TEX = {
  "12": 100.0,
  "30": 40.0,
  "40": 27.0,
  "60": 17.0,
  "75": 11.0
} as const;

/** The design options' defaults (a document leaving one out gets it). */
export const DESIGN_OPTIONS = {
  "appliqueCovers": true,
  "avoidHoles": true,
  "basting": "none",
  "bastingLength": 5.0,
  "bastingMargin": 6.0,
  "coverMaxSpacing": 1.0,
  "coverMinWidth": 1.5,
  "hiddenTravel": true,
  "keepUnderlay": false,
  "knockdown": false,
  "knockdownAngle": 45.0,
  "knockdownColor": "",
  "knockdownHoles": false,
  "knockdownLayers": 2,
  "knockdownLength": 4.0,
  "knockdownOffset": 2.0,
  "knockdownSpacing": 2.0,
  "minFragment": 2.0,
  "overlapMargin": 0.6,
  "removeOverlaps": false,
  "texturedCovers": false,
  "threadWeight": 40,
  "trimRunning": false
} as const;
