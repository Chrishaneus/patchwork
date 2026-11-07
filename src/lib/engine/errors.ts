import { m } from '#lib/paraglide/messages.js';
import type { EngineErrorCode } from './contract';

/** Translated, user-facing text for an engine error code. */
export function engineErrorMessage(code: EngineErrorCode): string {
	switch (code) {
		case 'path_not_found':
			return m.error_path_not_found();
		case 'not_a_git_repository':
			return m.error_not_a_git_repository();
		case 'no_remote':
			return m.error_no_remote();
		case 'already_added':
			return m.error_already_added();
		case 'repository_not_found':
			return m.error_repository_not_found();
		case 'invalid_input':
			return m.error_invalid_input();
		case 'outside_repository_roots':
			return m.error_outside_repository_roots();
		case 'folder_not_found':
			return m.error_folder_not_found();
		case 'local_paths_disabled':
			return m.error_local_paths_disabled();
		case 'invalid_url':
			return m.error_invalid_url();
		case 'clone_failed':
			return m.error_clone_failed();
		case 'github_login_unavailable':
			return m.error_github_login_unavailable();
		case 'github_not_signed_in':
			return m.error_github_not_signed_in();
		case 'unauthorized':
			return m.error_unauthorized();
		case 'repository_unavailable':
			return m.error_repository_unavailable();
		case 'run_not_found':
			return m.error_run_not_found();
		case 'task_not_found':
			return m.error_task_not_found();
		case 'invalid_state':
			return m.error_invalid_state();
		case 'invalid_branch':
			return m.error_invalid_branch();
		case 'git_failed':
			return m.error_git_failed();
		case 'agent_failed':
			return m.error_agent_failed();
		case 'timeout':
			return m.error_timeout();
		case 'nothing_to_publish':
			return m.error_nothing_to_publish();
		case 'git_identity_missing':
			return m.error_git_identity_missing();
		case 'push_failed':
			return m.error_push_failed();
		case 'github_token_missing':
			return m.error_github_token_missing();
		case 'github_failed':
			return m.error_github_failed();
		case 'gitlab_token_missing':
			return m.error_gitlab_token_missing();
		case 'gitlab_failed':
			return m.error_gitlab_failed();
		case 'interrupted':
			return m.error_interrupted();
		case 'invalid_pull_request':
			return m.error_invalid_pull_request();
		case 'agent_not_signed_in':
			return m.error_agent_not_signed_in();
		case 'unreadable_result':
			return m.error_unreadable_result();
		default:
			return m.error_generic();
	}
}
