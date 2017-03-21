import Check from './Check'
import { logger } from '../../common/debug'
import * as EVENTS from '../model/GithubEvents'

const info = logger('autolabel', 'info')
const debug = logger('autolabel')
const error = logger('autolabel', 'error')

export default class Autolabel extends Check {

  static TYPE = 'autolabel'
  static NAME = 'Automatic pull request labeling'
  static HOOK_EVENTS = [EVENTS.PULL_REQUEST]


  /**
   * @param {GithubService} github
   */
  constructor(github, pullRequestHandler) {
    super()
    this.github = github
    this.pullRequestHandler = pullRequestHandler
  }

  async execute(config, hookPayload, token, dbRepoId) {
    const {action, repository, pull_request, number, issue} = hookPayload
    const repo = repository.name
    const owner = repository.owner.login
    const loadAll = true
    if (!config.autolabel || !config.autolabel.length) {
      return
    }
    if (pull_request.state === 'closed') {
      return
    }
    if (action === 'opened' || action === 'reopened' || action === 'synchronize') {
      // This might be an expensive fetch (I think it actually grabs _the entire patch of each file_...)
      const files = await this.github.fetchPullRequestFiles(owner, repo, number, token, loadAll)
      // For now, only do basic filename filtering, without considering conditionals on addition/deletion/etc.
      const labels = config.autolabel.filter(l => files.some(f => f.filename.match(new RegExp(l.pattern, 'i'))))
      const current_labels = await this.github.getIssueLabels(owner, repo, number, token)
      const add_labels = labels.map(l => l.label)
      let remove_labels = new Set(config.autolabel.map(l => l.label).filter(l => add_labels.indexOf(l) === -1))
      let new_labels = new Set([].concat(current_labels, add_labels).filter(l => !remove_labels.has(l)))
      this.github.replaceIssueLabels(owner, repo, number, [...new_labels], token)
    }
  }
}
