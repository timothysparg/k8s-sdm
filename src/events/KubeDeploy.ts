/*
 * Copyright © 2018 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    EventFired,
    EventHandler,
    Failure,
    failure,
    GraphQL,
    HandleEvent,
    HandlerContext,
    HandlerResult,
    logger,
    Secret,
    Secrets,
    Success,
    success,
    Tags,
} from "@atomist/automation-client";
import * as Github from "@octokit/rest";
import * as appRoot from "app-root-path";
import * as stringify from "json-stringify-safe";
import * as k8 from "kubernetes-client";
import * as path from "path";

import { preErrMsg, reduceResults } from "../error";
import { createDeployCommitStatus, kubeDeployContextPrefix } from "../github";
import { upsertDeployment } from "../k8";
import { KubeDeploySub } from "../typings/types";

@EventHandler("deploy image to Kubernetes cluster",
    GraphQL.subscriptionFromFile("kubeDeploy", __dirname))
@Tags("deploy", "kubernetes")
export class KubeDeploy implements HandleEvent<KubeDeploySub.Subscription> {

    @Secret(Secrets.OrgToken)
    private githubToken: string;

    public handle(ev: EventFired<KubeDeploySub.Subscription>, ctx: HandlerContext): Promise<HandlerResult> {

        return Promise.all(ev.data.Status.map(s => {

            const env = eligibleDeployStatus(s);
            if (!env) {
                logger.info("push is not eligible for GKE deploy");
                return Promise.resolve(Success);
            }
            const owner = s.commit.repo.org.owner;
            const repo = s.commit.repo.name;
            const teamId = s.commit.repo.org.team.id;
            const sha = s.commit.sha;
            const description = (s.description) ? s.description : undefined;
            const image = s.commit.images[0].imageName;

            const github = new Github();
            try {
                github.authenticate({
                    type: "token",
                    token: this.githubToken,
                });
            } catch (e) {
                logger.warn("failed to authenticate with GitHub using token, with not perform " +
                    `kube deploy: ${e.message}`);
                return Promise.resolve(Success);
            }

            let k8Config: k8.ClusterConfiguration | k8.ClientConfiguration;
            const cfgPath = path.join(appRoot.path, "..", "creds", "kube", "config");
            try {
                const kubeconfig = k8.config.loadKubeconfig(cfgPath);
                k8Config = k8.config.fromKubeconfig(kubeconfig);
            } catch (e) {
                logger.debug(`failed to use ${cfgPath}: ${e.message}`);
                try {
                    k8Config = k8.config.getInCluster();
                } catch (er) {
                    logger.debug(`failed to use in-cluster-config: ${er.message}`);
                    logger.warn("failed to use either kubeconfig or in-cluster-config, will not deploy: " +
                        `${e.message};${er.message}`);
                    return Promise.resolve(Success);
                }
            }

            return upsertDeployment(k8Config, owner, repo, teamId, image, env)
                .catch(e => {
                    createDeployCommitStatus(github, owner, repo, sha, teamId, env, description, "failure");
                    return Promise.reject(preErrMsg(e, `failed to deploy image ${image}`));
                })
                .then(() => createDeployCommitStatus(github, owner, repo, sha, teamId, env, description)
                    .catch(e => Promise.reject(preErrMsg(e, `deployed image ${image} but failed to update status`))))
                .then(() => Success)
                .catch(e => {
                    logger.error(e.message);
                    return { code: Failure.code, message: e.message };
                });
        }))
            .then(results => reduceResults(results));
    }
}

/**
 * Determine if status event should be deployed to GKE.
 *
 * @param s status event
 * @return environment string if eligible, undefined otherwise
 */
export function eligibleDeployStatus(s: KubeDeploySub.Status): string {
    if (s.context.indexOf(kubeDeployContextPrefix) !== 0) {
        logger.debug(`${s.commit.repo.org.owner}/${s.commit.repo.name} commit status context '${s.context}' ` +
            `does not start with '${kubeDeployContextPrefix}'`);
        return undefined;
    }
    if (s.commit.images.length !== 1) {
        logger.debug(`${s.commit.repo.org.owner}/${s.commit.repo.name} commit ${s.commit.sha} has ` +
            `${s.commit.images.length} Docker images: ${stringify(s.commit.images)}`);
        return undefined;
    }
    if (s.targetUrl) {
        logger.debug(`${s.commit.repo.org.owner}/${s.commit.repo.name} commit ${s.commit.sha} status already has ` +
            `a targetUrl: ${s.targetUrl}`);
        return undefined;
    }
    const env = s.context.replace(kubeDeployContextPrefix, "");
    return env;
}
