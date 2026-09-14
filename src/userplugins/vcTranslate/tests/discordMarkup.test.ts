import { describe, expect, it } from "vitest";

import { renderDiscordMarkup, type MarkupResolvers } from "../discordMarkup";

/**
 * A resolver set backed by plain maps, so each test can say exactly which ids
 * resolve to what without a real Discord store. An id absent from a map returns
 * undefined, which is the "unresolved" case the transform must turn into the
 * neutral placeholder — never the numeric id.
 */
function resolvers(overrides: Partial<{
    users: Record<string, string>;
    channels: Record<string, string>;
    roles: Record<string, string>;
}> = {}): MarkupResolvers {
    const { users = {}, channels = {}, roles = {} } = overrides;
    return {
        user: id => users[id],
        channel: id => channels[id],
        role: id => roles[id]
    };
}

describe("renderDiscordMarkup", () => {
    it("resolves a user mention to @displayname", () => {
        const r = resolvers({ users: { "123": "deniz" } });
        expect(renderDiscordMarkup("Hey <@123> coucou", r)).toBe("Hey @deniz coucou");
    });

    it("resolves the nickname form <@!id> the same as <@id>", () => {
        const r = resolvers({ users: { "123": "deniz" } });
        expect(renderDiscordMarkup("Hey <@!123>", r)).toBe("Hey @deniz");
    });

    it("resolves a channel mention to #name", () => {
        const r = resolvers({ channels: { "555": "general" } });
        expect(renderDiscordMarkup("see <#555>", r)).toBe("see #general");
    });

    it("resolves a role mention to @rolename", () => {
        const r = resolvers({ roles: { "777": "Moderators" } });
        expect(renderDiscordMarkup("ping <@&777>", r)).toBe("ping @Moderators");
    });

    it("renders a custom emoji as just its name", () => {
        const r = resolvers();
        expect(renderDiscordMarkup("lol <:blob:123>", r)).toBe("lol :blob:");
    });

    it("renders an animated custom emoji as just its name", () => {
        const r = resolvers();
        expect(renderDiscordMarkup("<a:party:999> yay", r)).toBe(":party: yay");
    });

    it("falls back to the neutral placeholder (never the id) for an unresolved user", () => {
        const r = resolvers();
        const out = renderDiscordMarkup("hi <@1237044536178507949>", r);
        expect(out).toBe("hi @user");
        expect(out).not.toContain("1237044536178507949");
    });

    it("falls back to #channel and @role when unresolved, never the id", () => {
        const r = resolvers();
        expect(renderDiscordMarkup("<#404>", r)).toBe("#channel");
        expect(renderDiscordMarkup("<@&404>", r)).toBe("@role");
        expect(renderDiscordMarkup("<#404> <@&404>", r)).not.toMatch(/404/);
    });

    it("treats a resolver that returns an empty/blank name as unresolved", () => {
        const r = resolvers({ users: { "123": "   " }, channels: { "555": "" } });
        expect(renderDiscordMarkup("<@123> <#555>", r)).toBe("@user #channel");
    });

    it("leaves @everyone and @here untouched", () => {
        const r = resolvers();
        expect(renderDiscordMarkup("yo @everyone and @here", r)).toBe("yo @everyone and @here");
    });

    it("leaves a message with no entities unchanged", () => {
        const r = resolvers({ users: { "123": "deniz" } });
        expect(renderDiscordMarkup("just a normal sentence, no markup", r))
            .toBe("just a normal sentence, no markup");
    });

    it("resolves multiple mixed entities in one message", () => {
        const r = resolvers({
            users: { "1": "alice", "2": "bob" },
            channels: { "10": "off-topic" },
            roles: { "20": "VIP" }
        });
        expect(
            renderDiscordMarkup("<@1> told <@2> in <#10> that <@&20> <:wave:5> matters", r)
        ).toBe("@alice told @bob in #off-topic that @VIP :wave: matters");
    });

    it("never throws when a resolver throws — falls back to the placeholder", () => {
        const throwing: MarkupResolvers = {
            user: () => { throw new Error("store not ready"); },
            channel: () => { throw new Error("store not ready"); },
            role: () => { throw new Error("store not ready"); }
        };
        expect(() => renderDiscordMarkup("<@1> <#2> <@&3>", throwing)).not.toThrow();
        expect(renderDiscordMarkup("<@1> <#2> <@&3>", throwing)).toBe("@user #channel @role");
    });

    it("returns non-string / empty input safely", () => {
        const r = resolvers();
        expect(renderDiscordMarkup("", r)).toBe("");
    });
});
