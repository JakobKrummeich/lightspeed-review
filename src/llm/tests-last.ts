import type { DiffFile, DiffGroup } from "../diff-extract.ts";

/**
 * Every test file, pulled into one group at the end. The prompt asks and the
 * model does not comply — it pairs each source file with its test; blind review
 * of real diffs wanted the checks in one place at the end. An instruction the
 * model ignores twice is a rule the code should keep, so this runs on every
 * model grouping and on the fallback. Last means last, behind the mechanical
 * group: the first shape put tests ahead of mechanical bulk, and a diff whose
 * only other group was mechanical then opened on tests with the intent at the
 * bottom.
 */
export function trailTests(groups: DiffGroup[]): DiffGroup[] {
  const tests = groups.flatMap((group) => group.files.filter((file) => isTestFile(file.path)));
  if (tests.length === 0) return groups;
  const remaining = groups
    .map((group) => ({ ...group, files: group.files.filter((file) => !isTestFile(file.path)) }))
    .filter((group) => group.files.length > 0);
  return [...remaining, testGroup(tests)];
}

/**
 * Named for what the reviewer does with it, like every other group name, and
 * its rationale says what these files are — true wherever this group lands,
 * including a grouping where it is the only one left.
 */
function testGroup(files: DiffFile[]): DiffGroup {
  return {
    name: "Tests",
    rationale: "The checks this change ships, gathered to be read or skipped together.",
    // Never swept, on the same reasoning that puts these files last rather than
    // dropping them: a test is the check on the code just read, which is exactly
    // a thing to read.
    tier: "study",
    files,
  };
}

export interface TestPathConvention {
  /** The ecosystem and the shape, as someone looking for a missing one reads it. */
  name: string;
  pattern: RegExp;
  /** Paths this rule must claim. Every extension the rule names gets one. */
  examples: readonly string[];
  /** Paths no rule may claim. The reason this table is narrow. */
  counterexamples: readonly string[];
}

/**
 * Where each ecosystem puts its tests, one entry per convention. Examples and
 * counterexamples are part of the rule: `test/llm/tests-last.test.ts` iterates
 * this table — every example claimed by its own entry, every entry sole claimant
 * of at least one, no rule claims a counterexample — so a swallowed rule fails
 * rather than rots. Narrow on purpose: directory rules match whole segments
 * (`contest/`, `src/testing/` are production), suffix rules name their
 * extensions (`openapi_spec.yaml` is a written spec) — a production file
 * misread as a test is dragged to the bottom, which costs more than a missed
 * test file. Only the directory rule is case-insensitive: suffix rules lean on
 * case to tell `OrderServiceTests.cs` from `Latest.cs`. Rust unit tests live
 * inline behind `#[cfg(test)]`; only `tests/` (integration) is recognisable.
 */
export const TEST_PATH_CONVENTIONS: readonly TestPathConvention[] = [
  {
    name: "test/ or tests/ directory: any language, Maven and Gradle's src/test, Rust integration tests",
    pattern: /(^|\/)tests?\//i,
    examples: [
      "test/server.test.ts",
      "test/browser/dom/main.test.ts",
      "tests/helpers/build.ts",
      "tests/api.rs",
      "src/test/java/com/x/OrderService.java",
      "Tests/AppTests/Order.swift",
      "Test/Program.cs",
    ],
    counterexamples: [
      "src/testing/harness.ts",
      "src/testing-utils.ts",
      "src/test-utils/render.tsx",
      "contest/runner.ts",
      "app/contests/models.rb",
      "src/latest/index.ts",
      "packages/latest-release/index.ts",
      "TestData/fixtures.json",
      "Fixtures/TestData/seed.json",
      "src/x/tests.ts",
      "src/test.ts",
      "docs/testing.md",
      "src/protest.ts",
      "src/attestation.ts",
      "internal/attest/attest.go",
      // Rust's unit tests are inside this file, behind `#[cfg(test)]`.
      "src/lib.rs",
    ],
  },
  {
    name: "Jest __tests__ and __mocks__ directories",
    pattern: /(^|\/)(__tests__|__mocks__)\//,
    examples: ["src/components/__tests__/panel.tsx", "src/__mocks__/node-fetch.ts"],
    counterexamples: ["src/mocks/server.ts"],
  },
  {
    name: "end-to-end suite at the repository root: e2e/, cypress/",
    // Anchored at the root and to code extensions, because `e2e` is also an
    // ordinary package name: `packages/e2e/src/server.ts` is a product.
    pattern: /^(e2e|cypress)\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/,
    examples: ["e2e/checkout-flow.ts", "cypress/e2e/login.cy.js"],
    counterexamples: [
      "packages/e2e/src/server.ts",
      "e2e/README.md",
      "src/e2e-config.ts",
      "cypress.config.ts",
    ],
  },
  {
    name: "Gradle instrumentation and integration source roots: src/androidTest, src/integrationTest",
    // `src/test` belongs to the directory rule above, not here.
    pattern: /(^|\/)src\/(androidTest|integrationTest)\//,
    examples: [
      "app/src/androidTest/java/com/x/Login.java",
      "app/src/integrationTest/kotlin/com/x/Api.kt",
    ],
    counterexamples: ["app/src/main/kotlin/com/x/TestClock.kt"],
  },
  {
    name: ".NET test project directory: Orders.Tests/, Orders.IntegrationTests/, Orders.Tests.Unit/",
    pattern: /(^|\/)[^/]+\.[A-Za-z]*Tests?(\.[A-Za-z]+)*\//,
    examples: [
      "MyProj.Tests/OrderService.cs",
      "MyProj.IntegrationTests/ApiFixture.cs",
      "MyProj.Test/Orders.cs",
      "MyProj.Tests.Unit/OrderService.cs",
      "Acme.UnitTests.Core/Runner.cs",
    ],
    counterexamples: [
      "Company.Latest/Release.cs",
      "Acme.Contest/Entry.cs",
      "MyApp/TestHelpers/Builder.cs",
    ],
  },
  {
    name: "RSpec directory, Ruby files only: spec/support/factories.rb",
    pattern: /(^|\/)spec\/.+\.rb$/,
    examples: ["spec/support/factories.rb", "spec/models/order_spec.rb"],
    counterexamples: ["web/src/spec/openapi.ts", "docs/spec/design.md"],
  },
  {
    name: "phpspec directory: spec/Order/OrderSpec.php",
    // `*Spec.php` on its own is not enough: outside `spec/`, a PHP class named
    // `ProtocolSpec` is a specification the product implements.
    pattern: /(^|\/)spec\/.+Specs?\.php$/,
    examples: ["spec/Order/OrderSpec.php"],
    counterexamples: ["src/protocol/ProtocolSpec.php"],
  },
  {
    name: "JS/TS dotted infix: panel.test.tsx, thing.spec.ts",
    pattern: /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/,
    examples: [
      "src/browser/panel.test.tsx",
      "src/thing.spec.ts",
      "src/app.test.js",
      "src/widget.spec.jsx",
      "src/worker.test.mjs",
      "src/worker.spec.cjs",
      "src/types.test.mts",
      "src/types.spec.cts",
    ],
    counterexamples: ["docs/api.spec.json", "docs/openapi.test.yaml"],
  },
  {
    name: "_test suffix: service_test.go, mesh_unittest.cpp, server_test.ts",
    pattern: /_(test|tests|unittest)\.(go|py|rb|exs|ex|rs|dart|c|cc|cpp|cxx|h|hh|hpp|m|mm|ts|js)$/i,
    examples: [
      "internal/orders/service_test.go",
      "orders/service_test.py",
      "app/models/order_test.rb",
      "lib/orders/service_test.exs",
      "lib/orders/helper_test.ex",
      "src/engine/mesh_test.rs",
      "lib/models/order_test.dart",
      "src/parser/lexer_test.c",
      "src/geometry/mesh_test.cc",
      "src/geometry/mesh_unittest.cpp",
      "src/geometry/hull_test.cxx",
      "src/geometry/hull_test.h",
      "src/geometry/hull_test.hh",
      "src/geometry/hull_test.hpp",
      "src/mac/window_test.m",
      "src/mac/window_test.mm",
      "std/http/server_test.ts",
      "std/http/server_test.js",
    ],
    counterexamples: [
      "lib/latest_test_results.py",
      "docs/openapi_test.md",
      "scripts/smoke_test.sh",
    ],
  },
  {
    name: "_spec suffix: order_spec.rb, stack_spec.lua",
    pattern: /_specs?\.(rb|lua)$/i,
    examples: ["app/models/order_spec.rb", "lua/stack_spec.lua"],
    counterexamples: ["docs/openapi_spec.yaml", "config/api_spec.json"],
  },
  {
    name: "Python test_ prefix, and pytest's conftest",
    pattern: /(^|\/)(test_[^/]+|conftest)\.py$/,
    examples: ["orders/test_service.py", "orders/conftest.py"],
    counterexamples: ["src/hottest.py", "src/protest.py"],
  },
  {
    name: "test class named for what it checks: OrderServiceTests.cs, OrderServiceTest.java",
    pattern: /Tests?\.(cs|fs|vb|java|kt|kts|scala|groovy|php|swift)$/,
    examples: [
      "src/Orders/OrderServiceTests.cs",
      "src/Orders/OrderServiceTest.cs",
      "src/Orders/OrderServiceTests.fs",
      "src/Orders/OrderServiceTest.vb",
      "src/main/java/com/x/OrderServiceTest.java",
      "src/main/java/com/x/OrderServiceTests.java",
      "app/src/main/kotlin/com/x/OrderServiceTest.kt",
      "buildSrc/BuildTest.kts",
      "modules/core/OrderServiceTest.scala",
      "modules/OrderTest.groovy",
      "src/Order/OrderTest.php",
      "Sources/Orders/OrderTests.swift",
    ],
    counterexamples: [
      "src/main/java/com/x/Testable.java",
      "src/Latest.cs",
      "src/Orders/TestDataBuilder.cs",
      "src/Orders/Spec.cs",
    ],
  },
  {
    name: "Spock, Kotest and specs2 spec class: OrderSpec.groovy, OrderServiceSpec.scala",
    // JVM-scripting only. In .NET, Java, VB, F# and Swift, `Spec` names a
    // production type that holds a specification, not a test of one.
    pattern: /Specs?\.(scala|groovy|kt|kts)$/,
    examples: [
      "modules/core/OrderServiceSpec.scala",
      "modules/core/OrderServiceSpecs.scala",
      "src/main/groovy/OrderSpec.groovy",
      "app/OrderSpec.kt",
      "buildSrc/BuildSpec.kts",
    ],
    counterexamples: [
      "src/Orders/OpenApiSpec.cs",
      "src/Api/SwaggerSpec.java",
      "src/Domain/ManifestSpecs.java",
    ],
  },
];

/** Whether any convention claims this path. `src/testing-utils.ts` is not one. */
export function isTestFile(path: string): boolean {
  return TEST_PATH_CONVENTIONS.some((convention) => convention.pattern.test(path));
}
