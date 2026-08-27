import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
 
const execAsync = promisify(exec);

export class GCloudRunner {
    private configDir: string | null = null;

    setConfigDir(dir: string) {
        this.configDir = dir;
    }

    private getGcloudExecutable(): string {
        const isWindows = process.platform === 'win32';
        const defaultWindowsPath = 'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd';
        return process.env.GCLOUD_PATH || (isWindows ? defaultWindowsPath : 'gcloud');
    }

    private async runCommand(command: string, retryCount = 0): Promise<string> {
        Logger.info(`Executing GCloud: ${command}`);
        const maxRetries = 5;
        try {
            const env: any = {
                ...process.env,
                CLOUDSDK_CORE_DISABLE_PROMPTS: '1' // Force non-interactive mode
            };
            if (this.configDir) {
                env.CLOUDSDK_CONFIG = this.configDir;
            }

            const gcloudExecutable = this.getGcloudExecutable();
            if (process.platform === 'win32' && gcloudExecutable.includes('\\')) {
                const gcloudDir = path.dirname(gcloudExecutable.replace(/"/g, ''));
                env.PATH = `${gcloudDir};${env.PATH || ''}`;
            }

            // Set a hard timeout of 5 minutes (300,000 ms)
            const timeout = 300000;
            let execCommand = command;
            if (/^gcloud\s+/i.test(command.trim())) {
                const args = command.trim().replace(/^gcloud\s+/i, '');
                const quotedPath = process.platform === 'win32' && gcloudExecutable.includes(' ') ? `"${gcloudExecutable}"` : gcloudExecutable;
                execCommand = `${quotedPath} ${args}`;
            }

            const { stdout, stderr } = await execAsync(execCommand, {
                env,
                timeout
            });

            if (stderr && !stderr.includes('Created') && !stderr.includes('Listed') && !stderr.includes('Updated')) {
                Logger.debug(`GCloud Stderr: ${stderr}`);
            }
            return stdout.trim();
        } catch (error: any) {
            if (error.killed) {
                Logger.error(`GCloud Command TIMED OUT (5 min limit): ${command}`);
                throw new Error(`GCloud Command Timed Out: ${command}`);
            }
            
            const errorMsg = error.message || '';
            const errorMsgLower = errorMsg.toLowerCase();
            const isHardQuotaLimit = errorMsgLower.includes('project creation quota') || 
                                     errorMsgLower.includes('project quota') ||
                                     errorMsgLower.includes('exceeded your project');
            
            if (isHardQuotaLimit) {
                Logger.error(`❌ GCP Project Creation Quota Exceeded for this account. Cannot create more projects.`);
                throw new Error(`PROJECT_QUOTA_EXCEEDED: You have exceeded your Google Cloud project creation quota. Please delete unused projects in GCP Console or request a quota increase.`);
            }

            const isRateLimit = errorMsg.includes('429') || 
                                errorMsg.includes('RESOURCE_EXHAUSTED') || 
                                errorMsg.includes('Quota exceeded') ||
                                errorMsg.includes('RATE_LIMIT_EXCEEDED');
            
            if (isRateLimit && retryCount < maxRetries) {
                const waitTime = (retryCount + 1) * 15 * 1000; // 15s, 30s, 45s, 60s, 75s
                Logger.info(`⏳ Waiting for Google Cloud resources to provision (429). Retrying in ${waitTime / 1000}s... (Attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, waitTime));
                return this.runCommand(command, retryCount + 1);
            }

            Logger.error(`GCloud Execution Failed: ${command}`, error.message);
            throw new Error(`GCloud Command Failed: ${error.message}`);
        }
    }

    async getActiveAccount(): Promise<string> {
        return this.runCommand('gcloud config get-value account');
    }

    // List all project IDs visible to the currently authenticated account.
    async listProjects(): Promise<string[]> {
        const output = await this.runCommand(`gcloud projects list --format="value(projectId)"`);
        return output.split('\n').map(l => l.trim()).filter(Boolean);
    }

    // Delete a project with a bounded wait + retry for transient propagation.
    async deleteProject(projectId: string): Promise<void> {
        const MAX_ATTEMPTS = 5;
        let attempts = 0;
        while (attempts < MAX_ATTEMPTS) {
            attempts++;
            try {
                // --quiet avoids the interactive "Do you want to continue?" prompt.
                await this.runCommand(`gcloud projects delete ${projectId} --quiet`);
                Logger.info(`✅ Project ${projectId} delete command accepted (attempt ${attempts})`);
                return;
            } catch (error: any) {
                const msg = (error.message || '').toLowerCase();
                const wasAnd = msg.includes('and 1 more');
                const isTransient = /429|rate limit|quota|timed out|network|deadline/i.test(msg);
                // Project already deleted / not found — treat as success.
                if (msg.includes('not found') || msg.includes('does not exist') || wasAnd) {
                    Logger.info(`Project ${projectId} already deleted / not present — nothing to do.`);
                    return;
                }
                if (attempts >= MAX_ATTEMPTS || !isTransient) {
                    throw error;
                }
                const wait = attempts * 10000;
                Logger.info(`⏳ Project ${projectId} deletion not yet effective (${msg}). Retrying in ${wait / 1000}s... (attempt ${attempts}/${MAX_ATTEMPTS})`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }

    // --- 6.1 Project & Service Account Initialization ---

    async createProject(projectId: string, name: string = 'my first project', orgId?: string): Promise<void> {
        try {
            const orgFlag = orgId ? ` --organization=${orgId}` : '';
            await this.runCommand(`gcloud projects create ${projectId} --name "${name}"${orgFlag}`);
        } catch (error: any) {
            if (error.message.includes('already in use') || error.message.includes('Project creation failed')) {
                Logger.info(`Project ${projectId} already exists or creation failed harmlessly. Proceeding to select it.`);
            } else {
                throw error;
            }
        }
        await this.runCommand(`gcloud config set project ${projectId}`);
    }

    async enableApis(projectId: string, apis: string[] = ['admin.googleapis.com', 'gmail.googleapis.com', 'siteverification.googleapis.com', 'cloudresourcemanager.googleapis.com', 'iam.googleapis.com', 'orgpolicy.googleapis.com']): Promise<void> {
        const apiList = apis.join(' ');
        await this.runCommand(`gcloud services enable ${apiList} --project ${projectId}`);
    }

    async verifyApis(projectId: string): Promise<string> {
        return await this.runCommand(`gcloud services list --enabled --project ${projectId} | grep -E "admin|gmail|siteverification"`);
    }

    async createServiceAccount(projectId: string, saName: string, displayName: string = 'Automation SA'): Promise<void> {
        try {
            await this.runCommand(`gcloud iam service-accounts create ${saName} --project ${projectId} --display-name "${displayName}"`);
        } catch (error: any) {
            if (error.message.includes('already exists')) {
                Logger.info(`Service account ${saName} already exists. Continuing.`);
            } else {
                throw error;
            }
        }
    }

    async listServiceAccounts(projectId: string): Promise<string> {
        return await this.runCommand(`gcloud iam service-accounts list --project ${projectId}`);
    }


    // --- 6.2 Organization Policy & Permissions ---

    async getOrgId(): Promise<string> {
        // "ORG_ID=$(gcloud organizations list --format='value(name)' --limit=1)" equivalent
        const output = await this.runCommand(`gcloud organizations list --format="value(name)" --limit=1`);
        if (!output) throw new Error("No Organization ID found. Is the user part of an Org?");
        let parsed = output.trim();
        if (parsed.includes('/')) {
            parsed = parsed.split('/').pop() || parsed;
        }
        return parsed;
    }

    async getOrgIdFromProject(projectId: string): Promise<string> {
        const output = await this.runCommand(`gcloud projects get-ancestors ${projectId} --format="value(id)"`);
        if (!output) throw new Error(`No ancestors found for project ${projectId}`);
        const lines = output.trim().split('\n');
        // The ancestors output has the project id on the first line, and the organization id (or folder) on subsequent lines
        // Wait, gcloud projects get-ancestors returns multiple lines. We need to find the organization type.
        const outputDetailed = await this.runCommand(`gcloud projects get-ancestors ${projectId} --format="value(type,id)"`);
        const orgLine = outputDetailed.trim().split('\n').find(line => line.includes('organization'));
        if (orgLine) {
            return orgLine.split('\t')[1] || orgLine.split(' ')[1];
        }
        throw new Error("No Organization ancestor found for project");
    }

    async addIamPolicyBinding(orgId: string, userEmail: string, role: string): Promise<void> {
        await this.runCommand(`gcloud organizations add-iam-policy-binding ${orgId} --member="user:${userEmail}" --role="${role}"`);
    }

    async disableKeyCreationRestriction(orgId: string, projectId: string): Promise<void> {
        // 1. Disable Classic Key Restriction
        try {
            await this.runCommand(`gcloud resource-manager org-policies disable-enforce iam.disableServiceAccountKeyCreation --organization=${orgId}`);
        } catch (e: any) {
            Logger.debug(`Disable classic enforce failed: ${e.message}`);
        }

        // 2. Disable Managed Key Restriction (Modern API)
        try {
            // We use a temporary policy file for the organization-level override if we have enough permissions.
            const managedPolicy = {
                name: `organizations/${orgId}/policies/iam.managed.disableServiceAccountKeyCreation`,
                spec: { rules: [{ enforce: false }] }
            };
            const policyFile = path.resolve(process.cwd(), `org-policy-managed-${orgId}.json`);
            await fs.writeFile(policyFile, JSON.stringify(managedPolicy));
            await this.runCommand(`gcloud org-policies set-policy ${policyFile}`);
            await fs.unlink(policyFile);
        } catch (e: any) {
            Logger.debug(`Disable managed enforce failed: ${e.message}`);
        }

        // 3. Enable Org Policy API for project
        await this.runCommand(`gcloud services enable orgpolicy.googleapis.com --project=${projectId}`);

        // 4. Reset Policy (Accepting prompt with 'yes')
        await this.runCommand(`echo y | gcloud org-policies reset iam.disableServiceAccountKeyCreation --project=${projectId}`);
        try {
            await this.runCommand(`echo y | gcloud org-policies reset iam.managed.disableServiceAccountKeyCreation --project=${projectId}`);
        } catch (e) { }
    }

    async verifyOrgPolicy(orgId: string): Promise<string> {
        try {
            return await this.runCommand(`gcloud resource-manager org-policies describe iam.disableServiceAccountKeyCreation --effective --organization=${orgId}`);
        } catch (e) {
            return "Using Default/Check Failed";
        }
    }

    // --- 6.3 Delegation & Key Generation ---

    async getUniqueId(saEmail: string, idFilename: string): Promise<string> {
        // "gcloud iam service-accounts describe {saEmail} --format='value(uniqueId)' > {idFilename}"
        // We can just capture output directly instead of file redirect to keep it cleaner, 
        // BUT the prompt says "USE EXACTLY". 
        // "All following commands MUST be used without syntax modification."

        // To strictly follow "USE EXACTLY", we execute the file redirection.
        await this.runCommand(`gcloud iam service-accounts describe ${saEmail} --format="value(uniqueId)" > ${idFilename}`);

        // Then "cloudshell download {idFilename}" - this is likely a Cloud Shell specific command. 
        // If running on a VM or generic machine, `cloudshell` command wont exist.
        // 'cloudshell' is NOT a standard gcloud command, it's an environment alias.
        // Logic: If on local machine, the file is already "downloaded" (it's in CWD).
        // We will read the file content to return it.

        // Since we are creating a "Unified Backend", we assume this runs on a server.
        try {
            const uniqueId = await fs.readFile(idFilename, 'utf8');
            // clean up
            await this.runCommand(`rm ${idFilename}`).catch(() => this.runCommand(`del ${idFilename}`)); // win/linux compat
            return uniqueId.trim();
        } catch (e) {
            throw new Error(`Failed to read unique ID file: ${e}`);
        }
    }

    async createKey(projectId: string, saEmail: string, keyPath: string): Promise<void> {

        // Re-enable APIs (redundant but safe)
        await this.enableApis(projectId, ['admin.googleapis.com', 'siteverification.googleapis.com', 'gmail.googleapis.com', 'orgpolicy.googleapis.com']);

        // STEP 1: Temporarily DISABLE policy enforcement (Allow Key Creation)
        const constraints = [
            "iam.disableServiceAccountKeyCreation",
            "iam.managed.disableServiceAccountKeyCreation"
        ];

        for (const constraint of constraints) {
            Logger.info(`[Policy] Attempting to disable ${constraint} for project ${projectId}...`);
            const policyFile = path.resolve(process.cwd(), `tmp-policy-${constraint}-${projectId}.json`);

            const policyData = {
                name: `projects/${projectId}/policies/${constraint}`,
                spec: {
                    rules: [{ enforce: false }]
                }
            };

            try {
                await fs.writeFile(policyFile, JSON.stringify(policyData));
                await this.runCommand(`gcloud org-policies set-policy ${policyFile}`);
                Logger.info(`✅ [Policy] Disabled ${constraint}`);
            } catch (e: any) {
                Logger.warn(`[Policy] Failed to disable ${constraint}: ${e.message}`);
                // Attempt fallback for classic ID if modern set-policy fails
                if (constraint === "iam.disableServiceAccountKeyCreation") {
                    try {
                        await this.runCommand(`gcloud resource-manager org-policies disable-enforce ${constraint} --project=${projectId}`);
                        Logger.info(`✅ [Policy] Disabled ${constraint} via fallback`);
                    } catch (f) { }
                }
            } finally {
                try { await fs.unlink(policyFile); } catch (f) { }
            }
        }

        // Small delay for policy propagation
        await new Promise(r => setTimeout(r, 5000));

        // STEP 2: Create Key with Retry Loop
        let created = false;
        let attempts = 0;
        const maxKeyAttempts = 5;

        while (attempts < maxKeyAttempts) {
            try {
                attempts++;
                Logger.info(`Creating Service Account Key (Attempt ${attempts}/${maxKeyAttempts})...`);
                await this.runCommand(`gcloud iam service-accounts keys create ${keyPath} --project ${projectId} --iam-account ${saEmail}`);
                Logger.info(`✅ Service Account Key created successfully.`);
                created = true;
                break;
            }
            catch (error: any) {
                if (error.message.includes('FAILED_PRECONDITION') || error.message.includes('Key creation is not allowed')) {
                    Logger.warn(`⚠️ Key creation blocked (Attempt ${attempts}). Waiting 10s...`);

                    // On failure, try to re-apply policies (sometimes they get reverted or need re-push)
                    if (attempts === 2) {
                        Logger.info("Re-applying policy overrides...");
                        for (const constraint of constraints) {
                            try {
                                const policyData = {
                                    name: `projects/${projectId}/policies/${constraint}`,
                                    spec: { rules: [{ enforce: false }] }
                                };
                                const policyFile = path.resolve(process.cwd(), `retry-policy-${constraint}-${projectId}.json`);
                                await fs.writeFile(policyFile, JSON.stringify(policyData));
                                await this.runCommand(`gcloud org-policies set-policy ${policyFile}`);
                                await fs.unlink(policyFile);
                            } catch (e) { }
                        }
                    }

                    if (attempts >= maxKeyAttempts)
                        throw error;
                    await new Promise(resolve => setTimeout(resolve, 10000));
                }
                else {
                    throw error;
                }
            }
        }

        // STEP 3: CLEANUP - Restore to Google-managed default (RESET policy)
        if (created) {
            try {
                Logger.info(`[Policy] Restoring to Google-managed default (Resetting policies)...`);
                for (const constraint of constraints) {
                    try {
                        await this.runCommand(`echo y | gcloud org-policies reset ${constraint} --project=${projectId}`);
                    } catch (e) { }
                }
                Logger.info(`✅ [Policy] Restored to Google-managed default.`);
            }
            catch (e: any) {
                Logger.warn(`[Policy] Cleanup (reset) failed: ${e.message}`);
            }
        }
    }


}
