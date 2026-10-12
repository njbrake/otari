import { describe, expect, it } from "vitest"
import { scopesFor } from "./usageQuery"

const manager = {
  isManager: true,
  canReadOrganization: false,
  ownUserId: "u-me",
  isFindingOwnUserId: false,
}

describe("scopesFor", () => {
  it("offers a member their own usage only", () => {
    expect(
      scopesFor({ ...manager, isManager: false, ownUserId: undefined }),
    ).toEqual(["you"])
  })

  it("offers a workspace manager the workspace, then their own", () => {
    expect(scopesFor(manager)).toEqual(["workspace", "you"])
  })

  it("adds the organization for someone who manages it", () => {
    expect(scopesFor({ ...manager, canReadOrganization: true })).toEqual([
      "workspace",
      "you",
      "organization",
    ])
  })

  it("drops You for a manager whose own requests cannot be told apart", () => {
    expect(
      scopesFor({
        ...manager,
        canReadOrganization: true,
        ownUserId: undefined,
      }),
    ).toEqual(["workspace", "organization"])
  })

  it("keeps You while the roster that names the caller loads", () => {
    expect(
      scopesFor({
        ...manager,
        ownUserId: undefined,
        isFindingOwnUserId: true,
      }),
    ).toEqual(["workspace", "you"])
  })
})
