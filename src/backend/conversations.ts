import {
  Joule,
  JouleBot,
  Mode,
  ClaudeConversation,
  ClaudeMessage,
  PseudoCommit,
  Conversation,
  GitRepo,
} from "../types";
import * as pseudoCommits from "./pseudoCommits";
import * as joules from "./joules";
import * as prompts from "./prompts";
import * as claudeAPI from "../lib/claudeAPI";
import * as diffApplicatorXml from "./diffApplicatorXml";
// import { RepoMap } from './repoMap';

export function create(): Conversation {
  return { joules: [] };
}

function addJoule(conversation: Conversation, joule: Joule): Conversation {
  return { joules: [...conversation.joules, joule] };
}

export function respondHuman(
  conversation: Conversation,
  message: string,
  pseudoCommit: PseudoCommit
): Conversation {
  const newJoule = joules.createJouleHuman(message, pseudoCommit);
  return addJoule(conversation, newJoule);
}

export async function respondBot(
  conversation: Conversation,
  gitRepo: GitRepo,
  contextPaths: string[],
  mode: Mode,
  processPartial: (partialJoule: Joule) => void
): Promise<Conversation> {
  const currentPseudoCommit = lastJoule(conversation)!.pseudoCommit;
  // TODO 100: Add a loop here to try to correct the response if it's not good yet

  // TODO 300 (abstraction over 100 and 200): Constructing a unit of work might require multiple LLM steps: find context, make diff, make corrections.
  // We can try each step multiple times. All attempts should be represented by a tree. We pick one leaf to respond with.

  const systemPrompt = (() => {
    switch (mode) {
      case "code":
        return (
          prompts.codeModeSystemPrompt() +
          prompts.diffDecoderPrompt() +
          prompts.exampleConversationsPrompt() +
          prompts.codeChangeCommandRulesPrompt()
        );
      case "ask":
        return prompts.askModeSystemPrompt();
    }
  })();

  const claudeConversation: ClaudeConversation = {
    system: systemPrompt,
    messages: [
      // TODOV2 user system info
      ...encodeRepoMap(currentPseudoCommit),
      ...encodeContext(gitRepo, currentPseudoCommit, contextPaths),
      ...encodeMessages(conversation),
    ],
  };

  // TODO 200: get five responses, pick the best one with pickResponse

  // TODOV2 write a claudePlus
  let partialJoule = joules.createJouleBot(
    "",
    mode,
    currentPseudoCommit,
    contextPaths
  );
  const finalResponse = await claudeAPI.streamClaude(
    claudeConversation,
    (responseFragment) => {
      partialJoule = joules.updateMessage(
        partialJoule,
        partialJoule.message + responseFragment
      ) as JouleBot;
      processPartial(partialJoule);
    }
  );
  console.log(finalResponse);

  const { messageChunksList, searchReplaceList } =
    diffApplicatorXml.splitResponse(finalResponse);

  // reset the diff preview
  const pseudoCommitNoDiff =
    pseudoCommits.createFromPrevious(currentPseudoCommit);

  const newPseudoCommit =
    mode === "code"
      ? diffApplicatorXml.applySearchReplaceBlocks(
          gitRepo,
          pseudoCommitNoDiff,
          searchReplaceList
        )
      : pseudoCommitNoDiff;

  const newJoule = joules.createJouleBot(
    messageChunksList.join("\n"),
    mode,
    newPseudoCommit,
    contextPaths
  );
  const newConversation = addJoule(conversation, newJoule);
  return newConversation;
}

/**
 * Encodes files for Claude. Note that we're being loose with the newlines.
 * @returns string encoding the files
 */
function encodeFile(
  gitRepo: GitRepo,
  pseudoCommit: PseudoCommit,
  path: string
) {
  const fileContents = pseudoCommits.getFileContents(
    gitRepo,
    pseudoCommit,
    path
  );
  return `${path}
\`\`\`
${fileContents.endsWith("\n") ? fileContents : fileContents + "\n"}\`\`\``;
}

function encodeContext(
  gitRepo: GitRepo,
  pseudoCommit: PseudoCommit,
  contextPaths: string[]
): ClaudeMessage[] {
  // in the future, this could handle other types of context, like web urls
  const fileEncodings = contextPaths
    .map((path) => encodeFile(gitRepo, pseudoCommit, path))
    .join("\n");

  return fileEncodings.length
    ? [
        {
          role: "user",
          content: `${prompts.filesUserIntro()}

${fileEncodings}`,
        },
        { role: "assistant", content: prompts.filesAsstAck() },
      ]
    : [];
}

function encodeRepoMap(pseudoCommit: PseudoCommit): ClaudeMessage[] {
  // return [
  //   { role: "user", content: `Here's a map of the repository I'm working in:

  //     ${new RepoMap({ root: "ROOT_DIR_TODO" }).getRepoMap(
  //       ["abc.py", "def.py"],
  //       ["ghi.py"]
  //     )}` },
  //   { role: "assistant", content: "Thanks. I'll pay close attention to this."}
  // ];
  return [];
}

export function lastJoule(conversation: Conversation): Joule | undefined {
  return conversation.joules.length
    ? conversation.joules[conversation.joules.length - 1]
    : undefined;
}

function encodeMessages(conversation: Conversation): ClaudeMessage[] {
  return conversation.joules.map((joule) => {
    return {
      role: joule.author === "human" ? "user" : "assistant",
      content: joule.message.length ? joule.message : "...", // appease Claude, who demands all messages be non-empty
    };
  });
}
