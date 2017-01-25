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
      const autolabels = config.autolabel.filter(l => files.some(f => f.filename.match(new RegExp(l.pattern, 'i'))))
      const labels = autolabels.map(l => l.label)
      await this.github.replaceIssueLabels(owner, repo, number, labels, token)
    }
  }
}
