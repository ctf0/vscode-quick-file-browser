# File Browser

based on [jeffgran](https://github.com/jeffgran/vscode-quick-file-browser) which is based on [bodil](https://github.com/bodil/vscode-file-browser) + fixes/enhancements

## Notes

- to create a new file or directory, we have 2 ways to do so

    > 1. the search value **DIDNT** match any file/directory
    >     - u will get the options where u can create either a file or folder with that value
    > 2. the search value **DID** match a file/directory
    >     - execute the command of `quick-file-browser.actions`
    >     - next u will have 2 sets of options for
    >         - create either a file or folder with that value
    >         - `rename/delete/etc..` the currently selected file/folder
