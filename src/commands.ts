import { getProjectDetail, getTestExecutionDetail, ProjectDetail, TestExecutionDetail } from "./helper";
import parse = require('parse-curl');
import * as vscode from 'vscode';


async function smartPaste()
{
  const curlIgnores = ['accept-', 'upgrade-', 'user-', 'connection', 'referer', 'sec-', 'origin', 'host', 'content-length'];

  let curlIgnoreHeader = (header: string) =>
  {
    for (let ignore of curlIgnores)
    {
      if (header.toLowerCase().startsWith(ignore))
      {
        return true;
      }
    }

    return false;
  }

  let convertCurl = (raw: string) =>
  {
    let steps: Array<string> = [];
    raw = raw.replace('--data-binary', '--data');
    const curl: object = parse(raw);
    steps.push('* url \'' + curl['url'] + '\'');
    const headers: object = curl['header'] || {};

    for (let key of Object.keys(headers))
    {
      if (curlIgnoreHeader(key))
      {
        continue;
      }

      let val: string = headers[key];
      steps.push('* header ' + key + ' = \'' + val + '\'');
    }

    let method: string = curl['method'];
    let body = curl['body'];

    if (!body && (method === 'POST' || method === 'PUT' || method === 'PATCH'))
    {
      body = '\'\'';
    }

    if (body)
    {
      steps.push('* request ' + body);
    }

    steps.push('* method ' + method.toLowerCase());
    return steps.join('\n');
  }

  let editor = vscode.window.activeTextEditor;
  let start = editor.selection.start;

  vscode.commands.executeCommand('editor.action.clipboardPasteAction').then(() =>
  {
    let end = editor.selection.end;
    let selection = new vscode.Selection(start.line, start.character, end.line, end.character);
    let selectedText = editor.document.getText(selection).trim();

    if (selectedText.startsWith('curl'))
    {
      editor.edit((editBuilder: vscode.TextEditorEdit) =>
      {
        editBuilder.replace(selection, convertCurl(selectedText) + '\n');
        editor.revealRange(new vscode.Range(start, start));
      });
    }
  })
}

async function getKarateDebugFile()
{
  let activeTextEditor = vscode.window.activeTextEditor;
  if (activeTextEditor !== undefined) {
    let activeFile = activeTextEditor.document.fileName;
    if (activeFile.endsWith(".feature"))
    {
      return activeFile;
    }

    let openTextDocuments = vscode.workspace.textDocuments;
    let openFeatureFiles = openTextDocuments.filter(e => e.fileName.endsWith(".feature"));

    if (openFeatureFiles.length == 1)
    {
      return openFeatureFiles[0].fileName;
    }

    if (openFeatureFiles.length > 1)
    {
      let quickPickItems = openFeatureFiles.map(e => e.fileName);
      let quickPickOptions = <vscode.QuickPickOptions>
        {
          canPickMany: false,
          ignoreFocusOut: true,
          placeHolder: "Select feature file to debug..."
        };

      let quickPickFile = await vscode.window.showQuickPick(quickPickItems, quickPickOptions);

      if (quickPickFile !== undefined)
      {
        return quickPickFile;
      }
    }
  }

  return "";
}

async function runAllKarateTests(args)
{
  let tedArray: TestExecutionDetail[] = await getTestExecutionDetail(args.uri, args.type);

  let commandArgs = new Array();
  commandArgs.push(tedArray[0].karateOptions);
  commandArgs.push(tedArray[0].karateJarOptions);
  commandArgs.push(args.uri);
  commandArgs.push(args.type);

  runKarateTest(commandArgs);
}

async function runKarateTest(args)
{
  let karateRunner = null;
  let karateOptions: String = args[0];
  let karateJarOptions: String = args[1];
  let targetTestUri: vscode.Uri = args[2];
  let targetTestUriType: vscode.FileType = args[3];

  let mavenCmd = "mvn";
  let gradleCmd = "gradle";
  let mavenBuildFile = "pom.xml";
  let gradleBuildFile = "build.gradle";
  let standaloneBuildFile = "karate.jar";
  let mavenBuildFileSwitch = "-f";
  let gradleBuildFileSwitch = "-b";

  let runPhases = null;
  let runCommandPrefix = null;
  let runCommand = null;

  let projectDetail: ProjectDetail = getProjectDetail(targetTestUri, targetTestUriType);
  let projectRootPath = projectDetail.projectRoot;
  let runFilePath = projectDetail.runFile;


  if (runFilePath == "")
  {
    return;
  }

  if (!runFilePath.toLowerCase().endsWith(standaloneBuildFile))
  {
    if (Boolean(vscode.workspace.getConfiguration('karateRunner.karateRunner').get('promptToSpecify')))
    {
      karateRunner = await vscode.window.showInputBox
        (
          {
            prompt: "Karate Runner",
            value: String(vscode.workspace.getConfiguration('karateRunner.karateRunner').get('default'))
          }
        );

      if (karateRunner !== undefined && karateRunner !== "")
      {
        await vscode.workspace.getConfiguration().update('karateRunner.karateRunner.default', karateRunner)
      }
    }
    else
    {
      karateRunner = String(vscode.workspace.getConfiguration('karateRunner.karateRunner').get('default'));
    }

    if (karateRunner === undefined || karateRunner === "")
    {
      return;
    }

    if (Boolean(vscode.workspace.getConfiguration('karateRunner.buildDirectory').get('cleanBeforeEachRun')))
    {
      runPhases = "clean test";
    }
    else
    {
      runPhases = "test";
    }

    if (runFilePath.toLowerCase().endsWith(mavenBuildFile))
    {
      runCommandPrefix = `${mavenCmd} ${runPhases} ${mavenBuildFileSwitch}`;
    }

    if (runFilePath.toLowerCase().endsWith(gradleBuildFile))
    {
      runCommandPrefix = `${gradleCmd} ${runPhases} ${gradleBuildFileSwitch}`;
    }

    if (runCommandPrefix == null)
    {
      return;
    }

    runCommand = `${runCommandPrefix} "${runFilePath}" -Dtest=${karateRunner} -Dkarate.options="${karateOptions}"`;
  }
  else
  {
    let karateJarArgs = String(vscode.workspace.getConfiguration('karateRunner.karateJar').get('commandLineArgs'));

    if (karateJarArgs === undefined || karateJarArgs === "")
    {
      return;
    }

    runCommand = `${karateJarArgs} ${karateJarOptions}`;
  }

  let relativePattern = new vscode.RelativePattern(projectRootPath, String(vscode.workspace.getConfiguration('karateRunner.buildReports').get('toTarget')));
  let watcher = vscode.workspace.createFileSystemWatcher(relativePattern);
  let reportUrisFound: vscode.Uri[] = [];

  watcher.onDidCreate((e) =>
  {
    if (reportUrisFound.toString().indexOf(e.toString()) === -1)
    {
      reportUrisFound.push(e);
    }
  });

  watcher.onDidChange((e) =>
  {
    if (reportUrisFound.toString().indexOf(e.toString()) === -1)
    {
      reportUrisFound.push(e);
    }
  });

  let seo: vscode.ShellExecutionOptions = { cwd: projectRootPath }
  let exec = new vscode.ShellExecution(runCommand, seo);
  let task = new vscode.Task
    (
      { type: 'karate' },
      vscode.TaskScope.Workspace,
      'Karate Runner',
      'karate',
      exec,
      []
    );

  /*
  tasks.onDidStartTask((e) => 
  {
    if (e.execution.task.name == 'Karate Runner')
    {
    }
  });
  */

  vscode.tasks.onDidEndTask((e) =>
  {
    if (e.execution.task.name == 'Karate Runner')
    {
      watcher.dispose();

      if (Boolean(vscode.workspace.getConfiguration('karateRunner.buildReports').get('openAfterEachRun')))
      {
        reportUrisFound.forEach((reportUri) =>
        {
          openBuildReport(reportUri);
        });
      }
    }

    reportUrisFound = [];
  });

  vscode.tasks.executeTask(task);
}

function displayReportsTree(displayType)
{
  vscode.workspace.getConfiguration().update('karateRunner.buildReports.activityBarDisplayType', displayType);
}

function displayTestsTree(displayType)
{
  vscode.workspace.getConfiguration().update('karateRunner.tests.activityBarDisplayType', displayType);
}

function openBuildReport(reportUri)
{
  vscode.env.openExternal(reportUri);
}

function openFileInEditor(args)
{
  let fileUri = args.uri;
  vscode.window.showTextDocument(fileUri);
}

export { smartPaste, getKarateDebugFile, runKarateTest, runAllKarateTests, displayReportsTree, displayTestsTree, openBuildReport, openFileInEditor };