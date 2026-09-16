import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const targetSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const tagObjectSha = "c".repeat(40);
const releaseTag = "v0.1.0";
const context = { repo: { owner: "example", repo: "native" } };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function job(name: string) {
  const source = workflow.split(`\n  ${name}:\n`)[1];
  assert.ok(source, `missing ${name} job`);
  return source.split(/\n  \w+:\n/)[0];
}

function script(source: string) {
  const block = source.match(/          script: \|\n((?:            .*\n|\n)+)/)?.[1];
  assert.ok(block, "missing workflow-owned script");
  return new AsyncFunction("github", "context", "core", "process", block.replace(/^ {12}/gm, ""));
}

const freeze = script(job("tag"));
const verify = script(job("release"));

function fixture(existing = false) {
  const state = {
    ref: existing ? { type: "tag", sha: tagObjectSha } : null as null | { type: string; sha: string },
    object: { type: "commit", sha: targetSha },
    outputs: {} as Record<string, string>,
    createdTags: 0,
  };
  const github = {
    rest: {
      git: {
        async getRef({ ref }: { ref: string }) {
          assert.equal(ref, `tags/${releaseTag}`);
          if (!state.ref) throw Object.assign(new Error("not found"), { status: 404 });
          return { data: { object: state.ref } };
        },
        async getTag({ tag_sha }: { tag_sha: string }) {
          assert.equal(tag_sha, tagObjectSha);
          return { data: { object: state.object } };
        },
        async createTag({ object, type }: { object: string; type: string }) {
          assert.equal(object, targetSha);
          assert.equal(type, "commit");
          state.createdTags++;
          return { data: { sha: tagObjectSha } };
        },
        async createRef({ ref, sha }: { ref: string; sha: string }) {
          assert.equal(ref, `refs/tags/${releaseTag}`);
          state.ref = { type: "tag", sha };
        },
      },
    },
  };
  const core = { setOutput: (name: string, value: string) => { state.outputs[name] = value; } };
  const env = { TAG: releaseTag, TARGET_SHA: targetSha, EXPECTED_TAG_OBJECT: existing ? tagObjectSha : "" };
  return {
    state,
    freeze: () => freeze(github, context, core, { env }),
    verify: () => verify(github, context, core, {
      env: { ...env, TAG_OBJECT_SHA: state.outputs["tag-object-sha"] },
    }),
  };
}

describe("frozen release source", () => {
  it("checks out the validated commit despite a same-named branch and tag", () => {
    const refs = new Map([[`refs/remotes/origin/${releaseTag}`, otherSha], [`refs/tags/${releaseTag}`, targetSha]]);
    // actions/checkout@3d3c42 src/input-helper.ts accepts bare SHAs as commits;
    // src/ref-helper.ts:getCheckoutInfo resolves an unqualified branch before a tag.
    const resolveCheckout = (ref: string) => /^[0-9a-f]{40}$/.test(ref)
      ? ref : refs.get(`refs/remotes/origin/${ref}`) ?? refs.get(`refs/tags/${ref}`);
    assert.equal(resolveCheckout(releaseTag), otherSha, "fixture must reproduce the collision");
    for (const name of ["sign", "release"]) {
      const input = job(name).match(/          ref: (.+)/)?.[1];
      const values: Record<string, string> = {
        "${{ needs.validate.outputs.tag }}": releaseTag,
        "${{ needs.validate.outputs.target-sha }}": targetSha,
      };
      assert.ok(input && values[input], `unexpected ${name} checkout input`);
      assert.equal(resolveCheckout(values[input]), targetSha, `${name} must execute validated source`);
    }
  });

  it("freezes and verifies a newly created annotated tag", async () => {
    const run = fixture();
    await run.freeze();
    assert.equal(run.state.createdTags, 1);
    assert.equal(run.state.outputs["tag-object-sha"], tagObjectSha);
    await run.verify();
  });

  it("reuses the same annotated object for existing-tag and published-release reruns", async () => {
    const run = fixture(true);
    await run.freeze();
    await run.verify();
    await run.freeze();
    await run.verify();
    assert.equal(run.state.createdTags, 0);
    assert.equal(run.state.outputs["tag-object-sha"], tagObjectSha);
  });

  for (const change of ["moved object", "lightweight tag", "wrong commit", "non-commit target", "deleted tag"]) {
    it(`stops publication and handoff after a ${change}`, async () => {
      const run = fixture(true);
      await run.freeze();
      await run.verify(); // First guard allows draft creation or an existing release.
      if (change === "moved object") run.state.ref = { type: "tag", sha: "d".repeat(40) };
      if (change === "lightweight tag") run.state.ref = { type: "commit", sha: targetSha };
      if (change === "wrong commit") run.state.object.sha = otherSha;
      if (change === "non-commit target") run.state.object.type = "tag";
      if (change === "deleted tag") run.state.ref = null;
      const effects: string[] = [];
      await assert.rejects(async () => {
        await run.verify();
        effects.push("publish", "handoff");
      });
      assert.deepEqual(effects, []);
    });
  }

  it("rejects a tag moved between validation and the tag job", async () => {
    const run = fixture(true);
    run.state.ref = { type: "tag", sha: "d".repeat(40) };
    await assert.rejects(run.freeze, /changed after validation/);
    assert.equal(run.state.outputs["tag-object-sha"], undefined);
  });

  it("wires both guards to the same workflow-owned code, including published reruns", () => {
    const release = job("release");
    const first = release.indexOf("Verify frozen tag before release writes");
    const writes = release.indexOf("Create or resume release");
    const assets = release.indexOf("Download and independently verify release assets");
    const second = release.indexOf("Verify frozen tag before publication and handoff");
    const publish = release.indexOf("Publish verified draft");
    assert.ok(first >= 0 && first < writes && writes < assets && assets < second && second < publish);
    assert.match(release.slice(first, writes), /with: &verify-release-tag/);
    assert.match(release.slice(second, publish), /with: \*verify-release-tag/);
    assert.match(release.slice(second, publish), /env: \*release-tag-environment/);
    assert.doesNotMatch(release.slice(second, publish), /\bif:/);
    assert.match(release, /TAG_OBJECT_SHA: \$\{\{ needs\.tag\.outputs\.tag-object-sha \}\}/);
    assert.match(release, /needs: \[validate, tag, sign\]/);
    assert.match(job("tag"), /tag-object-sha: \$\{\{ steps\.freeze\.outputs\.tag-object-sha \}\}/);
  });
});
