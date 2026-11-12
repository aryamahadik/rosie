// The Workers test projects' setup (T-1243, DL-509; vitest.config.ts's "workers" and "e2e-workers" projects run it before
// each test file): it holds a HandleActor's own wiring of the isolate (runtime/src/wiring/root.ts setActorWiring).
//
// Why. Wherever the Worker runs, each HandleActor wires its isolate's actor ports as it is built (runtime/src/index.ts),
// since a stub call or an alarm can land in an isolate no request or retry batch has wired. The pool is one isolate that
// runs every test's actors, so an actor wiring itself there would put staging's root over the ports a test installed, or
// over the unwired defaults a test that installs nothing proves. With the hold, an actor a test builds wires nothing: it
// keeps the ports that test installed, or its unwired defaults where it installed none, so every existing test runs
// exactly as it did before T-1243. The fetch and queue entries wire the isolate as before, hold or not.
//
// runtime/src/wiring/actor-wiring.worker.test.ts lifts the hold (setActorWiring("auto")) to prove what a deployed Worker
// does. A deployed Worker never imports this file: it is no module of the Worker's graph (runtime/src/index.ts), only of
// the test projects' setup, so every deployed actor wires its isolate.
import { setActorWiring } from "../src/wiring/root";

setActorWiring("held");
