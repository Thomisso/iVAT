#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const file = process.env.TRACKER_FAKE_GITHUB;
const remote = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
const endpoint = args[args.indexOf("api") + 1].split("?")[0];
const input = args.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : {};
let response;
if (remote.fail) {
  console.error(remote.fail);
  process.exit(1);
}
if (endpoint === "graphql") {
  const operation = input.query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
  const variables = input.variables ?? {};
  const value = variables.input ?? {};
  switch (operation) {
    case "TrackerProject": response = { user: { projectV2: remote.project } }; break;
    case "TrackerFields": response = { node: { fields: { nodes: remote.fields, pageInfo: { hasNextPage: false } } } }; break;
    case "TrackerWorkflows": response = { node: { workflows: { nodes: remote.workflows ?? [], pageInfo: { hasNextPage: false } } } }; break;
    case "TrackerDeleteWorkflow": remote.workflows = remote.workflows.filter(workflow => workflow.id !== value.workflowId); response = { deleteProjectV2Workflow: { deletedWorkflowId: value.workflowId } }; break;
    case "TrackerAddItem": {
      remote.items ??= {};
      remote.items[value.contentId] ??= { id: `item-${value.contentId}`, values: {} };
      response = { addProjectV2ItemById: { item: { id: remote.items[value.contentId].id } } };
      break;
    }
    case "TrackerSetFields": {
      response = {};
      for (const [index, field] of Object.values(variables).entries()) {
        const item = Object.values(remote.items).find(item => item.id === field.itemId);
        item.values[field.fieldId] = field.value ?? null;
        response[`f${index}`] = { projectV2Item: { id: item.id } };
      }
      break;
    }
    case "TrackerUpdateField": {
      const field = remote.fields.find(item => item.id === value.fieldId);
      field.options = value.singleSelectOptions.map((option, index) => ({ ...option, id: `${field.id}-${index}` }));
      response = { updateProjectV2Field: { projectV2Field: field } };
      break;
    }
    case "TrackerCreateField": {
      const field = { id: `field-${remote.fields.length}`, name: value.name, dataType: value.dataType };
      if (value.singleSelectOptions) field.options = value.singleSelectOptions.map((option, index) => ({ ...option, id: `${field.id}-${index}` }));
      remote.fields.push(field);
      response = { createProjectV2Field: { projectV2Field: field } };
      break;
    }
    default: throw new Error(`Unmodelled GraphQL operation ${operation}`);
  }
  response = { data: response };
} else if (endpoint === "user") {
  response = { login: "maintainer" };
} else if (endpoint === "repos/example/project") {
  response = { full_name: "example/project", owner: { login: "example", type: "User" }, default_branch: "main" };
} else if (endpoint === "repos/example/project/issues/99/comments" && method === "GET") {
  response = remote.registry ? [{ id: 900, body: remote.registry }] : [];
} else if (endpoint === "repos/example/project/issues/99/comments" && method === "POST") {
  remote.registry = input.body;
  response = { id: 900, body: input.body };
} else if (endpoint === "repos/example/project/issues/comments/900" && method === "PATCH") {
  remote.registry = input.body;
  response = { id: 900, body: input.body };
} else if (endpoint === "repos/example/project/issues/201") {
  response = { number: 201, node_id: "I_201", title: "A real issue", html_url: "https://github.com/example/project/issues/201", state: "open" };
} else if (endpoint === "repos/example/project/issues/201/parent") {
  response = { number: 200 };
} else if (endpoint === "repos/example/project/issues/201/assignees") {
  remote.assignees = input.assignees;
  response = {};
} else if (endpoint === "repos/example/project/issues/201/comments" && method === "GET") {
  response = remote.ticketComments ?? [];
} else if (endpoint === "repos/example/project/issues/201/comments" && method === "POST") {
  remote.ticketComments ??= [];
  remote.ticketComments.push({ id: 901, body: input.body });
  response = remote.ticketComments.at(-1);
} else if (endpoint === "repos/example/project/issues/comments/901" && method === "PATCH") {
  remote.ticketComments[0].body = input.body;
  response = remote.ticketComments[0];
} else if (endpoint === "repos/example/project/actions/workflows/agent-tracking.yml/dispatches") {
  remote.dispatches ??= [];
  remote.dispatches.push(input.inputs.event);
  fs.writeFileSync(file, JSON.stringify(remote));
  const worker = spawnSync(process.execPath, [process.env.TRACKER_COMMAND, "worker"], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_JOB: "publish", GITHUB_WORKFLOW_REF: "example/project/.github/workflows/agent-tracking.yml@refs/heads/main", GITHUB_ACTOR: "maintainer", TRACKER_EVENT: input.inputs.event },
  });
  if (worker.status !== 0) console.error(worker.stderr);
  console.log(JSON.stringify({ workflow_run_id: 123, run_url: "https://api.github.com/repos/example/project/actions/runs/123", html_url: "https://github.com/example/project/actions/runs/123" }));
  process.exit(0);
} else throw new Error(`Unmodelled REST operation ${method} ${endpoint}`);
fs.writeFileSync(file, JSON.stringify(remote));
console.log(JSON.stringify(response));
